const http = require("http");
const https = require("https");
const express = require("express");
const compression = require("compression");
const bodyParser = require("body-parser");
const axios = require("axios");

// initialize rosnodejs
const rosnodejs = require("rosnodejs");
console.log("Loading packages...");
rosnodejs.loadAllPackages();
console.log("Done.");

let rosPublisher = undefined;
let token = "";
let jackalHardwareId = "";
let loggedIn = false;
let intervalId = 0;
let activeTrip = false;
let preTrip = 0;
let postTrip = 0;
let last_nav_status = 1;

// maintain global current status
let currentStatus = {
  latitude: 0.0,
  longitude: 0.0,
  spotStatus: "available",
  chargeLevel: 0,
};

// maintain current navigation path
let navPath = [];

// const instance= axios.create({baseURL: 'http://ut-smads.herokuapp.com'});
const instance = axios.create({
  baseURL: "http://kif.csres.utexas.edu:8095",  
  //baseURL: "http://hypnotoad.csres.utexas.edu:8085",
});
// const instance= axios.create({baseURL: '10.0.0.31:8085'});

const sendRobotStatus = async () => {
  const config = {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  };
  try {
    const res = await instance.put(
      `/spots/0/statusUpdate`,
      currentStatus,
      config
    );
    console.log(currentStatus);
    console.log("Status sent");
  } catch (e) {
    if (e.response.status === 503) {
      let publisher = rosPublisher;
      if (publisher !== undefined) {
        publisher.publish({
          x: currentStatus.longitude,
          y: currentStatus.longitude,
        });
      }
    }
    console.error(`Error sending server update ${e}`);
  }
};

const rosMessageHandler = (msg) => {
  console.log("Recieved ROS message");
  // update current status attributes if they exist
  if (msg.hardware_id !== undefined) {
    jackalHardwareId = msg.hardware_id;
  }
  if (msg.point) {
    currentStatus.latitude = msg.point.x;
    currentStatus.longitude = msg.point.y;
  }
  if (msg.measured_battery) {
    currentStatus.chargeLevel = Math.floor(msg.measured_battery);
  }
};

const pathMsgHandler = (msg) => {
  console.log("Received path from navigation.");
  //console.log(msg.poses[0].pose.position);
  navPath = [];
  const poses = msg.poses;
  if (msg.poses) {
    msg.poses.map((pose) => {
      navPath = navPath.concat({
        latitude: pose.pose.position.x,
        longitude: pose.pose.position.y,
      });
    });
  }
  console.log(navPath);
};

const navStatusMsgHandler = (msg) => {
  if (msg.goal_id == msg.SUCCEEDED && lastNavMsg.goal_id != msg.goal_id) {
    currentStatus.spotStatus = "dropoff";
    console.log("Changing robot status to dropoff");
  }
  lastNavMsg = msg;
};


const receiveAppRequest = async (req, res) => {
  try {
    console.log("Received command from app backend:");
    console.log(req.body);
    res.set("Content-Type", "application/json");
    const response = {
      locationPoints: navPath,
    };
    let publisher = rosPublisher;
    // publish 2D pose msg to ROS
    if (publisher !== undefined) {
      console.log(`Publishing ${publisher}`);
      publisher.publish({
        x: parseFloat(req.body.dropoffLocation.latitude),
        y: parseFloat(req.body.dropoffLocation.longitude),
        theta: 0.0,
      });
    }
    // update status of spot when a trip is received
    currentStatus.spotStatus = req.body.assignedSpot.status;
    activeTrip = true;
    res.status(200).send(JSON.stringify(response));
  } catch (e) {
    console.log(e.toString());
    res.status(500).send("Exception: " + e.toString());
  }
};

const cancelTrip = async (req, res) => {
  try {
    console.log("Cancelling trip.");
    res.set("Content-Type", "application/json");
    let publisher = rosPublisher;
    if (publisher !== undefined) {
      publisher.publish({
        x: currentStatus.longitude,
        y: currentStatus.longitude,
      });
    } else {
      res.status(200).send(JSON.stringify({ success: false }));
    }
    currentStatus.spotStatus = "available";
    activeTrip = false;
    res.status(200).send(JSON.stringify({ success: true }));
  } catch (e) {
    console.log(e);
    res.status(500).send(`Exception: ${e}`);
  }
};

const robotLogin = async () => {
  // login credentials
  const login = {
    username: "0",
    password: "smads_jackal",
    name: "jackal",
  };

  try {
    console.log("logging in");
    const res = await instance.post(`/auth/login`, login);
    token = res.data.token;
    console.log(`Logged in. Authorization token: ${token}`);
    loggedIn = true;
  } catch (e) {
    console.error(`Error sending server update: ${e}`);
  }
};

const getTripFromApp = async () => {
  const config = {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  };

  try {
    const res = await instance.get(`/spots/0/activeTrip`, config);
    console.log(res.data);
    if (res.data.id !== null) {
      let x = rosPublisher;
      // publish 2D pose msg to ROS
      if (x !== undefined) {
        console.log(`Publishing ${x}`);
        x.publish({
          x: parseFloat(res.data.dropoffLocation.latitude),
          y: parseFloat(res.data.dropoffLocation.longitude),
          theta: 0.0,
        });
        clearInterval(intervalId);
      }
      activeTrip = true;
      //clearInterval(preTrip);
    }
  } catch (e) {
    console.error(e.message);
  }
};

const main = (rosNode) => {
  // Subscribe to robot's GPS localization topic
  const localizationSubscriber = rosNode.subscribe(
    "/smads/localization/out/gps",
    "geometry_msgs/PointStamped",
    rosMessageHandler,
    { queueSize: 1, throttleMs: 1000 }
  );
  rosPublisher = rosNode.advertise(
    "/smads/navigation/in/cmd",
    "geometry_msgs/Pose2D"
  );
  console.log(`Publisher: ${rosPublisher}`);
  // Subscribe to jackal status topic
  const statusSubscriber = rosNode.subscribe(
    "/status",
    "jackal_msgs/Status",
    rosMessageHandler,
    { queueSize: 1, throttleMs: 1000 }
  );
  const pathSubscriber = rosNode.subscribe(
    "/smads/navigation/out/planned_path",
    "nav_msgs/Path",
    pathMsgHandler,
    { queueSize: 1, throttleMs: 1000 }
  );
  const navStatusSubscriber = rosNode.subscribe(
    "/smads/navigation/out/status",
    "actionlib_msgs/GoalStatus",
    navStatusMsgHandler,
    { queueSize: 1, throttleMs: 1000 }
  );

  if (!loggedIn) {
    robotLogin();
  }
  // regularly send updates to app backend
  preTrip = setInterval(sendRobotStatus, 1000);
  //postTrip = setInterval(sendRobotStatus, 10000);
  // poll to get a trip if it
  //intervalId = setInterval(getTripFromApp, 1000);
};

rosnodejs.initNode("/smads_app_client", { onTheFly: false }).then(main);

const robotAppClient = express();

robotAppClient.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  next();
});

robotAppClient.use(bodyParser.json({ limit: "10mb" }));
robotAppClient.use(compression());

robotAppClient.post("/newTrip", receiveAppRequest);
robotAppClient.put("/cancelledTrip", cancelTrip);

robotAppClient.listen(9143, () =>
  console.log("SMADS App client listening on port 9143")
);
