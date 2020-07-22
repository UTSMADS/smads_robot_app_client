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
let preTrip = 0;
let postTrip = 0;

// maintain global current status
let currentStatus = {
  latitude: 0.0,
  longitude: 0.0,
  spotStatus: "available",
  chargeLevel: 0,
};

const appUrl = "http://54.165.60.65";
// const appUrl = "10.0.0.31:8085";

const sendRobotStatus = async () => {
  const config = {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  };
  try {
    const res = await axios.put(
      `${appUrl}/spots/0/statusUpdate`,
      currentStatus,
      config
    );
    console.log(currentStatus);
    console.log("Status sent");
  } catch (e) {
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
    activeTrip = true;
    res.status(200).send(JSON.stringify(response));
  } catch (e) {
    console.log(e.toString);
    res.status(500).send("Exception: " + e.toString);
  }
};

const robotLogin = async () => {
  // login credentials
  // const login = {
  //   username: "0",
  //   password: "smads_jackal",
  //   name: "jackal",
  // };

  // try {
  //   console.log("logging in");
  //   const res = await axios.post(`${appUrl}/auth/login`, login);
  //   token = res.data.token;
  //   console.log(`Logged in. Authorization token: ${token}`);
  //   loggedIn = true;
  // } catch (e) {
  //   console.error(`Error sending server update: ${e}`);
  // }

  // login credentials
  const login = {
    emailAddress: "0",
    password: "smads_jackal",
    name: "jackal",
  };

  const loginString = JSON.stringify(login);
  var post_options = {
    host: "10.0.0.31",
    port: "8085",
    path: "/auth/login",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  };
  try {
    // Set up the request
    var post_req = http.request(post_options, function (res) {
      res.setEncoding("utf8");
      res.on("data", function (chunk) {
        const response = JSON.parse(chunk);
        token = response.token;
        console.log(`Logged in. Authorization token: ${token}`);
      });
      res.on("end", () => {
        console.log("no more data");
      });
    });
    post_req.on("error", function (e) {
      console.error("HTTP " + e);
    });
    // post the data
    post_req.write(loginString);
    post_req.end();
    console.log("success");
    loggedIn = true;
  } catch (e) {
    console.error("Error sending server update: " + e);
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
    const res = await axios.get(`${appUrl}/spots/0/activeTrip`, config);
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
      clearInterval(preTrip);
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
  // const pathSubscriber = rosNode.subscribe();
  if (!loggedIn) {
    robotLogin();
  }
  // regularly send updates to app backend
  preTrip = setInterval(sendRobotStatus, 1000);
  postTrip = setInterval(sendRobotStatus, 10000);
  // poll to get a trip if it
  intervalId = setInterval(getTripFromApp, 1000);
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
