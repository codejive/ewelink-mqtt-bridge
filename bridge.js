'use strict';

const Ewelink = require('ewelink-api');
const mqtt = require('mqtt');

function getEnv(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function getBooleanEnv(name, fallback) {
  const value = getEnv(name, String(fallback));
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function sanitizeTopicLevel(value) {
  return String(value).replace(/[+#/]/g, '_');
}

function toPayload(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

const config = {
  ewelinkEmail: getEnv('EWELINK_EMAIL'),
  ewelinkPassword: getEnv('EWELINK_PASSWORD'),
  ewelinkRegion: getEnv('EWELINK_REGION', 'us'),
  mqttUrl: getEnv('MQTT_URL', 'mqtt://127.0.0.1:1883'),
  mqttUser: getEnv('MQTT_USER'),
  mqttPass: getEnv('MQTT_PASS'),
  topicPrefix: getEnv('TOPIC_PREFIX', 'ewelink'),
  publishRawState: getBooleanEnv('PUBLISH_RAW_STATE', true),
  mqttRetain: getBooleanEnv('MQTT_RETAIN', true),
  mqttQos: Number(getEnv('MQTT_QOS', '1')),
  websocketHeartbeatMs: Number(getEnv('WEBSOCKET_HEARTBEAT_MS', '25000')),
  exitOnWsClose: getBooleanEnv('EXIT_ON_WEBSOCKET_CLOSE', true)
};

if (!config.ewelinkEmail || !config.ewelinkPassword) {
  console.error('EWELINK_EMAIL and EWELINK_PASSWORD are required.');
  process.exit(1);
}

if (![0, 1, 2].includes(config.mqttQos)) {
  console.error('MQTT_QOS must be 0, 1, or 2.');
  process.exit(1);
}

let websocket;
let shuttingDown = false;

const bridgeStatusTopic = `${config.topicPrefix}/bridge/status`;

const mqttClient = mqtt.connect(config.mqttUrl, {
  username: config.mqttUser,
  password: config.mqttPass,
  reconnectPeriod: 3000,
  will: {
    topic: bridgeStatusTopic,
    payload: 'offline',
    qos: 1,
    retain: true
  }
});

mqttClient.on('connect', () => {
  console.log(`Connected to MQTT broker: ${config.mqttUrl}`);
  mqttClient.publish(bridgeStatusTopic, 'online', { qos: 1, retain: true });
});

mqttClient.on('reconnect', () => {
  console.log('Reconnecting to MQTT broker...');
});

mqttClient.on('error', (err) => {
  console.error('MQTT error:', err.message || err);
});

function publishMqtt(topic, payload) {
  return new Promise((resolve) => {
    mqttClient.publish(
      topic,
      payload,
      { qos: config.mqttQos, retain: config.mqttRetain },
      (err) => {
        if (err) {
          console.error(`Publish failed: ${topic}`, err.message || err);
        }
        resolve();
      }
    );
  });
}

async function startBridge() {
  console.log(`Connecting to eWeLink cloud region: ${config.ewelinkRegion}`);

  const ewelink = new Ewelink({
    email: config.ewelinkEmail,
    password: config.ewelinkPassword,
    region: config.ewelinkRegion
  });

  websocket = await ewelink.openWebSocket(async (action) => {
    if (!action || action.action !== 'update' || !action.deviceid || !action.params) {
      return;
    }

    const deviceId = sanitizeTopicLevel(action.deviceid);
    const baseTopic = `${config.topicPrefix}/${deviceId}/state`;

    if (config.publishRawState) {
      await publishMqtt(`${baseTopic}/raw`, JSON.stringify(action.params));
    }

    const entries = Object.entries(action.params);
    for (const [key, value] of entries) {
      const topic = `${baseTopic}/${sanitizeTopicLevel(key)}`;
      await publishMqtt(topic, toPayload(value));
    }

    console.log(`Published ${entries.length}${config.publishRawState ? ' + raw' : ''} topics for device ${deviceId}`);
  }, { heartbeat: config.websocketHeartbeatMs });

  websocket.onOpen.addListener(() => {
    console.log('eWeLink websocket opened and listening for updates');
  });

  websocket.onClose.addListener((event) => {
    console.error('eWeLink websocket closed:', event && event.reason ? event.reason : 'no reason provided');
    if (!shuttingDown && config.exitOnWsClose) {
      process.exit(1);
    }
  });

  websocket.onError.addListener((event) => {
    console.error('eWeLink websocket error:', event && event.message ? event.message : event);
  });

  console.log('Bridge is running. Waiting for device updates...');
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down...`);

  if (websocket) {
    try {
      if (typeof websocket.close === 'function') {
        websocket.close();
      } else if (typeof websocket.terminate === 'function') {
        websocket.terminate();
      }
    } catch (err) {
      console.error('Failed to close websocket cleanly:', err.message || err);
    }
  }

  mqttClient.publish(bridgeStatusTopic, 'offline', { qos: 1, retain: true }, () => {
    mqttClient.end(true, () => process.exit(0));
  });

  setTimeout(() => process.exit(0), 1500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

startBridge().catch((err) => {
  console.error('Failed to start bridge:', err.message || err);
  process.exit(1);
});
