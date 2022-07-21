const AWS = require('aws-sdk');
const { NodeSSH } = require('node-ssh')

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let waitForState = async (wantedState, target, targetGroup, elbv2) => {

  var registered = null

  while (wantedState !== registered) {
    console.log(`Waiting for server to be ${wantedState ? 'registered' : 'deregistered'} ...`)
    let state = await elbv2.describeTargetHealth({
      TargetGroupArn: targetGroup.TargetGroupArn
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
}

(async () => {
  try {

    if(process.env.INPUT_ENV != "DEV" && 
      process.env.INPUT_ENV != "STAGING" && 
      process.env.INPUT_ENV != "PROD") {
        throw new Error("ENV is not valid")
      }

    let secret = process.env[`INPUT_AWS_SECRET_ACCESS_KEY_${process.env.INPUT_ENV}`]
    let id = process.env[`INPUT_AWS_SECRET_KEY_ID_${process.env.INPUT_ENV}`]

    let targetGroupARN = process.env[`INPUT_ARN_TARGET_GROUP_${process.env.INPUT_ENV}`]
    var serverList
    try {
      serverList = eval(process.env[`INPUT_SERVER_LIST_${process.env.INPUT_ENV}`])
    } catch (e) {
      throw e
    }

    if (secret === "" ||
      id === "" ||
      targetGroupARN === "" ||
      serverList.length === 0) {
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

    let res = await elbv2.describeTargetGroups({
      TargetGroupArns: [targetGroupARN]
    }).promise()

    let tg  = res.TargetGroups[0]
    let ssh = new NodeSSH()

    for (let i in serverList) {

      let instanceID = serverList[i]
      let instance = await ec2.describeInstances({
        InstanceIds: [instanceID]
      }).promise()

      instance = instance.Reservations[0].Instances[0]

      console.log(`Deregistering ${instanceID} ...`)
      await elbv2.deregisterTargets({
        TargetGroupArn: tg.TargetGroupArn,
        Targets: [{
          Id: instanceID
        }]
      }).promise()

      console.log(`Waiting for target to be deregistered ...`)
      await waitForState(false, instanceID, tg, elbv2)

      console.log("Updating via ssh")

      await ssh.connect({
        host: instance.PublicDnsName,
        username: 'ec2-user',
        privateKey: 'key.pem'
      })

      let exec = await ssh.execCommand(
        process.env.INPUT_COMMAND.replace(
          "{{SHA}}",
          process.env.INPUT_SHA,
        ),
      )

      if(exec.code !== 0) {
        throw new Error('Command failed')
      }

      console.log("Waiting for target to be ready ...")

      await elbv2.registerTargets({
        TargetGroupArn: tg.TargetGroupArn,
        Targets: [{
          Id: instanceID
        }]
      }).promise()
      console.log("Registering target back to the target group ...")
      await waitForState(true, instanceID, tg, elbv2)

      console.log(`Instance ${instanceID} successfuly updated !`)
    }
  } catch (error) {
    console.log(error)
  }
})()