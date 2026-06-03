'use strict';

const Ewelink = require('ewelink-api-next').default;
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
  ewelinkAccount: getEnv('EWELINK_ACCOUNT', getEnv('EWELINK_EMAIL')),
  ewelinkPassword: getEnv('EWELINK_PASSWORD'),
  ewelinkRegion: getEnv('EWELINK_REGION', 'us'),
  ewelinkAreaCode: getEnv('EWELINK_AREA_CODE', '+1'),
  ewelinkAppId: getEnv('EWELINK_APP_ID'),
  ewelinkAppSecret: getEnv('EWELINK_APP_SECRET'),
  mqttUrl: getEnv('MQTT_URL', 'mqtt://127.0.0.1:1883'),
  mqttUser: getEnv('MQTT_USER'),
  mqttPass: getEnv('MQTT_PASS'),
  topicPrefix: getEnv('TOPIC_PREFIX', 'ewelink'),
  publishRawState: getBooleanEnv('PUBLISH_RAW_STATE', true),
  verbose: getBooleanEnv('VERBOSE', false),
  mqttRetain: getBooleanEnv('MQTT_RETAIN', true),
  mqttQos: Number(getEnv('MQTT_QOS', '1')),
  exitOnWsClose: getBooleanEnv('EXIT_ON_WEBSOCKET_CLOSE', true)
};

if (!config.ewelinkAccount || !config.ewelinkPassword) {
  console.error('EWELINK_ACCOUNT and EWELINK_PASSWORD are required.');
  process.exit(1);
}

if (!config.ewelinkAppId || !config.ewelinkAppSecret) {
  console.error('EWELINK_APP_ID and EWELINK_APP_SECRET are required.');
  process.exit(1);
}

if (![0, 1, 2].includes(config.mqttQos)) {
  console.error('MQTT_QOS must be 0, 1, or 2.');
  process.exit(1);
}

let websocket;
let shuttingDown = false;
let exitCode = 0;

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
  mqttClient.publish(bridgeStatusTopic, 'online', { qos: 1, retain: true }, (err) => {
    if (err) {
      console.error('Failed to publish bridge online status:', err.message || err);
    }
  });
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

function getWebsocketRawMessage(message) {
  if (!message || typeof message.data === 'undefined' || message.data === null) {
    return null;
  }

  return Buffer.isBuffer(message.data) ? message.data.toString('utf8') : String(message.data);
}

function parseWebsocketPayload(raw) {
  if (!raw || raw[0] !== '{') {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse eWeLink websocket message:', err.message || err);
    return null;
  }

  // Handshake packet includes config but no device state.
  if (payload && payload.config) {
    console.log(`eWeLink websocket config received: ${raw}`);
    return null;
  }

  if (!payload || !payload.deviceid || !payload.params || typeof payload.params !== 'object') {
    return null;
  }

  if (payload.action && payload.action !== 'update') {
    return null;
  }

  return payload;
}

async function publishDeviceUpdate(action) {
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
}

async function loginWithRegionFallback(client) {
  let region = config.ewelinkRegion;

  let response = await client.user.login({
    account: config.ewelinkAccount,
    password: config.ewelinkPassword,
    areaCode: config.ewelinkAreaCode,
    lang: 'en'
  });

  if (response && response.error === 10004 && response.data && response.data.region) {
    region = response.data.region;
    console.log(`eWeLink account redirects to region: ${region}`);
    client.setUrl(region);
    response = await client.user.login({
      account: config.ewelinkAccount,
      password: config.ewelinkPassword,
      areaCode: config.ewelinkAreaCode,
      lang: 'en'
    });
  }

  return { response, region };
}

async function startBridge() {
  console.log(`Connecting to eWeLink cloud region: ${config.ewelinkRegion}`);

  const webApi = new Ewelink.WebAPI({
    appId: config.ewelinkAppId,
    appSecret: config.ewelinkAppSecret,
    region: config.ewelinkRegion
  });

  const { response: loginResponse, region: resolvedRegion } = await loginWithRegionFallback(webApi);
  if (!loginResponse || loginResponse.error) {
    const message = loginResponse && loginResponse.msg ? loginResponse.msg : JSON.stringify(loginResponse || {});
    throw new Error(`Failed to authenticate with eWeLink cloud: ${message}`);
  }

  const wsClient = new Ewelink.Ws({
    appId: config.ewelinkAppId,
    appSecret: config.ewelinkAppSecret,
    region: resolvedRegion
  });

  websocket = await wsClient.Connect.create(
    {
      region: resolvedRegion,
      at: webApi.at,
      userApiKey: webApi.userApiKey,
      appId: config.ewelinkAppId
    },
    () => {
      console.log('eWeLink websocket opened and listening for updates');
    },
    () => {
      console.error('eWeLink websocket closed');
      if (!shuttingDown && config.exitOnWsClose) {
        shutdown('WEBSOCKET_CLOSED', 1);
      }
    },
    (event) => {
      console.error('eWeLink websocket error:', event && event.message ? event.message : event);
    },
    async (_ws, message) => {
      const rawMessage = getWebsocketRawMessage(message);

      if (config.verbose && rawMessage !== null) {
        console.log('eWeLink websocket message:', rawMessage);
      }

      const action = parseWebsocketPayload(rawMessage);
      if (!action) {
        return;
      }

      await publishDeviceUpdate(action);
    }
  );

  console.log('Bridge is running. Waiting for device updates...');
}

async function shutdown(signal, requestedExitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  exitCode = requestedExitCode;

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

  const finish = (force) => {
    mqttClient.end(force, () => process.exit(exitCode));
  };

  const shutdownTimeout = setTimeout(() => {
    console.error('Timed out publishing offline status, forcing MQTT disconnect.');
    finish(true);
  }, 5000);

  if (!mqttClient.connected) {
    console.error('MQTT client is not connected during shutdown; forcing disconnect.');
    clearTimeout(shutdownTimeout);
    finish(true);
    return;
  }

  mqttClient.publish(bridgeStatusTopic, 'offline', { qos: 1, retain: true }, (err) => {
    clearTimeout(shutdownTimeout);

    if (err) {
      console.error('Failed to publish bridge offline status:', err.message || err);
      finish(true);
      return;
    }

    finish(false);
  });
}

process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('SIGTERM', () => shutdown('SIGTERM', 0));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  shutdown('UNHANDLED_REJECTION', 1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown('UNCAUGHT_EXCEPTION', 1);
});

startBridge().catch((err) => {
  console.error('Failed to start bridge:', err.message || err);
  shutdown('STARTUP_FAILURE', 1);
});
