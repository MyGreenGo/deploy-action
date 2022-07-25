const AWS = require('aws-sdk');
const { NodeSSH } = require('node-ssh')
const CLI = require('clui');

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

    let s = false

    for (let instance in state.TargetHealthDescriptions) {
      if (state.TargetHealthDescriptions[instance].Target.Id == target) {
        s = true
      }
    }
    registered = s
  }

  console.log("\n")
  countdown.stop()
}

(async () => {
  try {

    if(process.env.INPUT_ENV != "DEV" && 
      process.env.INPUT_ENV != "STAGING" && 
      process.env.INPUT_ENV != "PROD") {
        throw new Error("ENV is not valid")
      }

    let secret = process.env[`INPUT_AWS-SECRET-ACCESS-KEY-${process.env.INPUT_ENV}`]
    let id = process.env[`INPUT_AWS-SECRET-KEY-ID-${process.env.INPUT_ENV}`]

    let targetGroupARN = process.env[`INPUT_ARN-TARGET-GROUP-${process.env.INPUT_ENV}`]

    if (secret === "" ||
      id === "" ||
      targetGroupARN === "") {
      throw new Error("Missing param")
    }

    let conf = {
      accessKeyId: id,
      secretAccessKey: secret,
      region: "eu-west-3"
    }

    conf.apiVersion = '2015-12-01'
    let elbv2 = new AWS.ELBv2(conf);
    conf.apiVersion = '2016-11-15'
    let ec2 = new AWS.EC2(conf);

    let group = await elbv2.describeTargetHealth({
      TargetGroupArn: targetGroupARN
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
        TargetGroupArn: targetGroupARN,
        Targets: [{
          Id: instanceID
        }]
      }).promise()

      await waitForState(false, instanceID, targetGroupARN, elbv2)
      console.log("Deregistered.")

      console.log("Updating via ssh")

      await ssh.connect({
        host: instance.PublicDnsName,
        username: 'ec2-user',
        privateKey: '/github/workspace/key.pem'
      })

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
        throw new Error('Command failed')
      }

      await elbv2.registerTargets({
        TargetGroupArn: targetGroupARN,
        Targets: [{
          Id: instanceID
        }]
      }).promise()
      console.log("Registering target back to the target group ...")
      await waitForState(true, instanceID, targetGroupARN, elbv2)

      console.log(`Instance ${instanceID} successfuly updated !`)
    }
    process.exit(0)
  } catch (error) {
    console.log(error)
  }
})()