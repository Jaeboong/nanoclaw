# Observability Stack

This directory is the source-of-truth template. The install script copies it to `/home/ubuntu/observability` (override via `DST_DIR=...`).

## Layout

- `docker-compose.yml`: Prometheus, Grafana, Loki, Promtail, node_exporter, cAdvisor
- `loki/loki-config.yml`: Loki single-binary configuration with 30 day retention
- `promtail/promtail-config.yml`: Docker container log discovery and forwarding
- `prometheus/prometheus.yml`: scrape configuration
- `grafana/provisioning/`: datasource, dashboard provider, alert contact point
- `grafana/dashboards/`: dashboard JSON files downloaded from Grafana.com plus the bundled `per-container-logs.json`. Add your own dashboards here; they'll be auto-loaded by Grafana provisioning.

## First-time setup

1. Copy this tree to `/home/ubuntu/observability`.
2. Ensure `/home/ubuntu/nanoclaw/.env` contains `WEBHOOK_PORT=10257` and `WEBHOOK_TOKEN=...`.
3. Download the dashboard JSON files:

```bash
cd /home/ubuntu/observability
./grafana/dashboards/fetch-dashboards.sh
```

4. Start the stack:

```bash
cd /home/ubuntu/observability
docker compose config
docker compose up -d
```

## Operations

Start:

```bash
cd /home/ubuntu/observability
docker compose up -d
```

Stop:

```bash
cd /home/ubuntu/observability
docker compose down
```

Stop and remove data volumes:

```bash
cd /home/ubuntu/observability
docker compose down -v
```

Status:

```bash
cd /home/ubuntu/observability
docker compose ps
```

Logs:

```bash
cd /home/ubuntu/observability
docker compose logs -f prometheus
docker compose logs -f grafana
docker compose logs -f loki
docker compose logs -f promtail
```

## Access

By default Grafana binds to `0.0.0.0:3000` (host-wide); Prometheus and Loki are bound to `127.0.0.1` (loopback only).

Recommended access patterns:

- **SSH tunnel** (loopback-only deployments):

```bash
ssh -L 3000:127.0.0.1:3000 -L 9090:127.0.0.1:9090 -L 3100:127.0.0.1:3100 <user>@<host>
```

- **Tailscale** (private mesh, no public exposure):
  Install Tailscale on the host and your client. Reach Grafana at `http://<host-magicdns>:3000`. Make sure the host firewall allows the `tailscale0` interface.
- **Public exposure**: Not recommended without auth/TLS. If required, put Grafana behind a reverse proxy (Caddy/nginx) with TLS and an allowlist.

Endpoints:

- Grafana: `http://<host>:3000`
- Prometheus: `http://127.0.0.1:9090`
- Loki readiness: `http://127.0.0.1:3100/ready`

Initial Grafana credentials:

- username: `admin`
- password: `admin`

Change the Grafana admin password immediately after the first login.

## Alerting

The `NanoClaw` webhook contact point is provisioned automatically.
Grafana alert rules are not created by this stack. Add them manually in the Grafana UI and route them to the `NanoClaw` contact point.

## Loki Logs

Loki and Promtail are included for Docker container stdout/stderr aggregation with a retention period of `720h` (30 days).

Use Grafana Explore:

1. Open Grafana and select the `Loki` data source.
2. Start with a container selector such as `{container="<container-name>"}`.
3. Narrow by Compose project with `{compose_project="<project>"}`.

Useful LogQL examples:

```logql
{container="<container-name>"}
{compose_project="<project>"} |= "error"
sum(count_over_time({compose_project="<project>"}[5m]))
```

The provisioned `Per-Container Logs` dashboard includes:

- a live log view
- log volume time series
- an error rate panel

Monitor disk usage regularly because Loki stores data on the local Docker volume:

```bash
df -h
docker system df -v
docker volume ls | grep loki
```

If log volume grows unexpectedly, reduce retention or investigate noisy containers before the `loki_data` volume fills the host disk.

## NanoClaw webhook activation

After adding `WEBHOOK_PORT` and `WEBHOOK_TOKEN`, restart NanoClaw:

```bash
systemctl --user restart nanoclaw
```

Then confirm `/home/ubuntu/nanoclaw/logs/nanoclaw.log` contains a `Webhook server listening` line rather than `Webhook server skipped`.
