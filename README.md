# eWeLink to MQTT Bridge

`ewelink-mqtt-bridge` connects to the eWeLink cloud websocket and republishes device updates to any MQTT broker.

This is useful when your eWeLink devices can't connect directly to your MQTT broker. For example because your broker is on a public server and uses SSL, which the eWeLink devices don't support.

## How It Works

1. Authenticate to eWeLink cloud using app credentials and account credentials.
2. Open a persistent websocket to receive live device update events.
3. Publish each update to MQTT topics using a predictable topic structure.

## MQTT Topics

Default topic layout:

- `ewelink/<deviceId>/state/raw`
- `ewelink/<deviceId>/state/<key>`
- `ewelink/bridge/status`

Examples:

- `ewelink/1000abcdef/state/raw` -> `{"temperature":22.5,"humidity":48}`
- `ewelink/1000abcdef/state/temperature` -> `22.5`
- `ewelink/1000abcdef/state/humidity` -> `48`
- `ewelink/bridge/status` -> `online` or `offline`

Topic prefix is configurable via `TOPIC_PREFIX`.

The bridge publishes `ewelink/bridge/status=online` after connecting to the MQTT broker, and publishes `offline` during shutdown before closing MQTT cleanly. The MQTT last-will message is also set to `offline` so the status still flips if the process dies unexpectedly.

## Environment Variables

The bridge is configured only through environment variables.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `EWELINK_ACCOUNT` | Yes | - | eWeLink account identifier (email or phone number). |
| `EWELINK_PASSWORD` | Yes | - | eWeLink account password used for cloud login. |
| `EWELINK_APP_ID` | Yes | - | eWeLink developer app ID used for API authentication. |
| `EWELINK_APP_SECRET` | Yes | - | eWeLink developer app secret used for API authentication. |
| `EWELINK_REGION` | No | `us` | eWeLink region for your account. Valid values: `us`, `eu`, `cn`, `as`. |
| `EWELINK_AREA_CODE` | No | `+1` | Area code used during login (required by eWeLink login API). |
| `MQTT_URL` | No | `mqtt://127.0.0.1:1883` | MQTT broker URL. Examples: `mqtt://broker:1883`, `mqtts://broker:8883`. |
| `MQTT_USER` | No | empty | Username for MQTT authentication. |
| `MQTT_PASS` | No | empty | Password for MQTT authentication. |
| `TOPIC_PREFIX` | No | `ewelink` | Prefix used for all published topics. |
| `PUBLISH_RAW_STATE` | No | `true` | If `true`, publishes full update JSON to `<prefix>/<deviceId>/state/raw`. |
| `VERBOSE` | No | `false` | If `true`, logs every websocket message received from eWeLink, including non-update packets. |
| `MQTT_RETAIN` | No | `true` | If `true`, publishes state messages with retain flag enabled. |
| `MQTT_QOS` | No | `1` | MQTT QoS level for published messages. Allowed: `0`, `1`, `2`. |
| `EXIT_ON_WEBSOCKET_CLOSE` | No | `true` | If `true`, process exits when eWeLink websocket closes (recommended in containers with restart policy). |

Boolean variables (`PUBLISH_RAW_STATE`, `VERBOSE`, `MQTT_RETAIN`, `EXIT_ON_WEBSOCKET_CLOSE`) accept: `true/false`, `1/0`, `yes/no`, `on/off`.

## Getting App Credentials

This bridge requires your own eWeLink app credentials:

1. **Register an eWeLink Developer Account**
   - Visit [eWeLink Developer Platform](https://dev.ewelink.io/)
   - Create an account or log in

2. **Create an Application**
   - Navigate to the applications/credentials section
   - Create a new application
   - You'll receive an `APP_ID` and `APP_SECRET`

3. **Configure the Bridge**
   - Add `EWELINK_APP_ID` and `EWELINK_APP_SECRET` to your `.env` file or pass them as environment variables
   - Set `EWELINK_ACCOUNT` to your eWeLink email or phone number

If you're unable to obtain credentials, check the [eWeLink API Next documentation](https://www.npmjs.com/package/ewelink-api-next) or the [eWeLink community forums](https://www.ewelink.cc/).

## Quick Start (Node.js)

1. Install dependencies:

```bash
npm install
```

1. Run with required variables:

```bash
EWELINK_ACCOUNT="you@example.com" \
EWELINK_PASSWORD="your-password" \
EWELINK_REGION="eu" \
EWELINK_AREA_CODE="+1" \
EWELINK_APP_ID="your-app-id" \
EWELINK_APP_SECRET="your-app-secret" \
MQTT_URL="mqtt://127.0.0.1:1883" \
node bridge.js
```

## Docker

Build image:

```bash
docker build -t ewelink-mqtt-bridge:local .
```

Run container:

```bash
docker run -d \
  --name ewelink-mqtt-bridge \
  --restart unless-stopped \
  -e EWELINK_ACCOUNT="you@example.com" \
  -e EWELINK_PASSWORD="your-password" \
  -e EWELINK_REGION="eu" \
  -e EWELINK_AREA_CODE="+1" \
  -e EWELINK_APP_ID="your-app-id" \
  -e EWELINK_APP_SECRET="your-app-secret" \
  -e MQTT_URL="mqtt://broker:1883" \
  -e MQTT_USER="mqtt-user" \
  -e MQTT_PASS="mqtt-pass" \
  ewelink-mqtt-bridge:local
```

Use host networking only if your platform/setup requires it.

## Docker Compose

1. Copy `.env.example` to `.env` and fill in your values.
2. Update image in `docker-compose.yml` to your published image (or build locally and point to that tag).
3. Start:

```bash
docker compose up -d
```

## Publish to Docker Hub (Manual)

```bash
docker login
docker tag ewelink-mqtt-bridge:local <namespace>/ewelink-mqtt-bridge:latest
docker push <namespace>/ewelink-mqtt-bridge:latest
```

`<namespace>` can be a personal Docker Hub username or an organization name.

## Publish via GitHub Actions

Workflow: `.github/workflows/docker-publish.yml`

Required repository secrets:

- `DOCKERHUB_USERNAME`: Docker account used for login.
- `DOCKERHUB_TOKEN`: Docker access token.
- `DOCKERHUB_NAMESPACE`: Docker Hub namespace to publish to (user or organization).

Publish behavior:

- Push to default branch publishes `latest`.
- Push tag `v*.*.*` publishes version tags.

## Operational Notes

- If websocket connectivity drops, the bridge can exit and rely on container restart policy.
- MQTT retained messages are convenient for Home Assistant and similar consumers, but can be disabled with `MQTT_RETAIN=false`.
- The bridge manages `ewelink/bridge/status` itself: `online` on MQTT connect, `offline` on shutdown, and `offline` via MQTT last-will if the process stops unexpectedly.
- If your broker requires TLS, use an `mqtts://` URL and ensure trust/cert settings are provided by your runtime environment.

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE).
