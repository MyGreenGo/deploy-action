const AWS = require('aws-sdk');
const { NodeSSH } = require('node-ssh')
const CLI = require('clui');
const path = require('node:path');

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const waitForState = async (wantedState, target, targetGroupARN, elbv2) => {

  var registered = null;

  let Spinner = CLI.Spinner;
  let countdown = new Spinner(`Waiting for target to be ${wantedState ? 'registered' : 'deregistered'} ...`, ['⣾','⣽','⣻','⢿','⡿','⣟','⣯','⣷']);
  countdown.start();

  while (wantedState !== registered) {
    let state = await elbv2.describeTargetHealth({
      TargetGroupArn: targetGroupARN
    }).promise()

    await sleep(1000)

    let s = null

    for (let instance in state.TargetHealthDescriptions) {
      if (state.TargetHealthDescriptions[instance].Target.Id == target) {
        if (state.TargetHealthDescriptions[instance].TargetHealth.State == "healthy") {
          s = true
        } else if (state.TargetHealthDescriptions[instance].TargetHealth.State == "draining") {
          s = null
        }
      } else {
        s = false
      }
    }
    registered = s
  }

  console.log("\n")
  countdown.stop()
}

(async () => {
  try {

    if (process.env[`INPUT_AWS-SECRET-ACCESS-KEY`] === "" ||
        process.env[`INPUT_AWS-SECRET-KEY-ID`] === "" ||
        process.env[`INPUT_ARN-TARGET-GROUP`] === "") {
      throw new Error("Missing param")
    }

    let conf = {
      accessKeyId: process.env[`INPUT_AWS-SECRET-KEY-ID`],
      secretAccessKey: process.env[`INPUT_AWS-SECRET-ACCESS-KEY`],
      region: "eu-west-3"
    }

    conf.apiVersion = '2015-12-01'
    let elbv2 = new AWS.ELBv2(conf);
    conf.apiVersion = '2016-11-15'
    let ec2 = new AWS.EC2(conf);

    let group = await elbv2.describeTargetHealth({
      TargetGroupArn: process.env[`INPUT_ARN-TARGET-GROUP`]
    }).promise()

    let ssh = new NodeSSH()

    for (let i in group.TargetHealthDescriptions) {

      let instanceID = group.TargetHealthDescriptions[i].Target.Id

      let instance = await ec2.describeInstances({
        InstanceIds: [instanceID]
      }).promise()

      instance = instance.Reservations[0].Instances[0]

      console.log(`Deregistering ${instanceID} ...`)
      await elbv2.deregisterTargets({
        TargetGroupArn: process.env[`INPUT_ARN-TARGET-GROUP`],
        Targets: [{
          Id: instanceID
        }]
      }).promise()

      await waitForState(false, instanceID, process.env[`INPUT_ARN-TARGET-GROUP`], elbv2)
      console.log("Deregistered.")

      console.log("Updating via ssh")

      await ssh.connect({
        host: instance.PublicDnsName,
        username: 'ec2-user',
        privateKey: path.join(process.env[`INPUT_PATH`], "key.pem")
      })

      console.log(
        process.env.INPUT_COMMAND.replace(
          "{{SHA}}",
          process.env.INPUT_SHA,
        ).replace(
          "{{INPUT_NPM_TOKEN}}", 
          process.env["INPUT_NPM-TOKEN"]
        )
      )

      let exec = await ssh.execCommand(
        process.env.INPUT_COMMAND.replace(
          "{{SHA}}",
          process.env.INPUT_SHA,
        ).replace(
          "{{INPUT_NPM_TOKEN}}", 
          process.env["INPUT_NPM-TOKEN"]
        ),
      )

      if(exec.code !== 0) {
        await elbv2.registerTargets({
          TargetGroupArn: process.env[`INPUT_ARN-TARGET-GROUP`],
          Targets: [{
            Id: instanceID
          }]
        }).promise()
        console.log("Registering target back to the target group ...")
        await waitForState(true, instanceID, process.env[`INPUT_ARN-TARGET-GROUP`], elbv2)

        console.log(`Command on ${instanceID}, update aborted: ${exec.stderr}`)
        process.exit(1)
      }

      await elbv2.registerTargets({
        TargetGroupArn: process.env[`INPUT_ARN-TARGET-GROUP`],
        Targets: [{
          Id: instanceID
        }]
      }).promise()
      console.log("Registering target back to the target group ...")
      await waitForState(true, instanceID, process.env[`INPUT_ARN-TARGET-GROUP`], elbv2)

      console.log(`Instance ${instanceID} successfuly updated !`)
      await sleep(10000)
    }
    process.exit(0)
  } catch (error) {
    console.log(error)
  }
})()