const http = require("http");
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

// maintain global current status
let currentStatus = {
  latitude: 0.0,
  longitude: 0.0,
  spotStatus: "available",
  chargeLevel: 0,
};

const appUrl = "http://ut-smads.herokuapp.com";

const sendRobotStatus = async () => {
  const updateString = JSON.stringify(currentStatus);
  console.log(currentStatus);
  // An object of options to indicate where to put to
  var put_options = {
    host: "ut-smads.herokuapp.com",
    port: "80",
    path: "/spots/0/statusUpdate",
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(updateString),
      Authorization: `Bearer ${token}`,
    },
  };
  try {
    // Set up the request
    var put_req = http.request(put_options, function (res) {
      res.setEncoding("utf8");
    });
    put_req.on("error", function (e) {
      console.error("HTTP " + e);
    });
    // put the data
    put_req.write(updateString);
    put_req.end();
  } catch (e) {
    console.error("Error sending server update: " + e);
  }
};

const rosMessageHandler = (msg) => {
  console.log("Recieved ROS message");
  // update current status attributes if they exist
  if (msg.hardware_id !== undefined) {
    jackalHardwareId = msg.hardware_id;
  }
  if (msg.latitude) {
    currentStatus.latitude = msg.latitude;
  }
  if (msg.longitude) {
    currentStatus.longitude = msg.longitude;
  }
  if (msg.measured_battery) {
    currentStatus.chargeLevel = Math.floor(msg.measured_battery);
  }
};

const receiveAppRequest = async (req, res) => {
  try {
    console.log("Received command from app backend:");
    console.log(req.body);
    const response = {
      time: new Date(),
      response: "Ok",
    };
    let x = rosPublisher;
    // publish 2D pose msg to ROS
    if (x !== undefined) {
      console.log(`Publishing ${x}`);
      x.publish({
        x: parseFloat(req.body.dropoffLocation.latitude),
        y: parseFloat(req.body.dropoffLocation.longitude),
        theta: 0.0,
      });
    }
    // update status of spot when a trip is received
    currentStatus.spotStatus = req.body.tripStatus;
    res.status(200).send(JSON.stringify(response));
  } catch (e) {
    console.log(e.toString);
    res.status(500).send("Exception: " + e.toString);
  }
};

const robotLogin = async () => {
  // login credentials
  const login = {
    emailAddress: "0.3.9",
    password: "smads_jackal",
    name: "jackal",
  };

  try {
    console.log("logging in");
    const res = await axios.post(`${appUrl}/auth/login`, login);
    token = res.data.token;
    console.log(`Logged in. Authorization token: ${token}`);
    loggedIn = true;
  } catch (e) {
    console.error(`Error sending server update: ${e}`);
  }
};

const getTripFromApp = async () => {
  const get_options = {
    host: "ut-smads.herokuapp.com",
    port: '80',
    path: '/spots/0/activeTrip',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
    }
  }
  http.get(get_options, (res) => {
    res.setEncoding('utf8');
    let rawData = '';
    res.on('data', (chunk) => { rawData += chunk; });
    res.on('end', () => {
      try {
        const parsedData = JSON.parse(rawData);
        console.log(parsedData);
        if (parsedData.id !== null) {
          let x = rosPublisher;
          // publish 2D pose msg to ROS
          if (x !== undefined) {
            console.log(`Publishing ${x}`);
            x.publish({
              x: parseFloat(parsedData.dropoffLocation.latitude),
              y: parseFloat(parsedData.dropoffLocation.longitude),
              theta: 0.0
            });
            clearInterval(intervalId);
          }
          activeTrip = true;
        } 
      } catch (e) {
        console.error(e.message);
      }
    });
  }).on('error', (e) => {
    console.error(`Got error: ${e.message}`);
  });
};

const main = (rosNode) => {
  // Subscribe to robot's GPS localization topic
  const localization_subscriber = rosNode.subscribe(
    "/gps/fix",
    "sensor_msgs/NavSatFix",
    rosMessageHandler,
    { queueSize: 1, throttleMs: 1000 }
  );
  rosPublisher = rosNode.advertise(
    "/smads_waypoint/goal",
    "geometry_msgs/Pose2D"
  );
  console.log(`Publisher: ${rosPublisher}`);
  // Subscribe to jackal status topic
  const status_subscriber = rosNode.subscribe(
    "/status",
    "jackal_msgs/Status",
    rosMessageHandler,
    { queueSize: 1, throttleMs: 1000 }
  );
  if (!loggedIn) {
    robotLogin();
  }
  // regularly send updates to app backend
  setInterval(() => {
    sendRobotStatus();
  }, 1000);
  // poll to get a trip if it
  intervalId = setInterval(() => {
    getTripFromApp();
  }, 1000);
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
robotAppClient.listen(9143, () =>
  console.log("SMADS App client listening on port 9143")
);
