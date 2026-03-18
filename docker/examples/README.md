# Tracearr Docker Installation

Deploy Tracearr using Docker Compose. For full documentation, visit [docs.tracearr.com](https://docs.tracearr.com).

> **Unraid & TrueNAS:** Use Community Apps / TrueCharts instead of these compose files.

---

## Quick Start (Recommended)

```bash
# 1. Download compose file
curl -O https://raw.githubusercontent.com/connorgallopo/Tracearr/main/docker/examples/docker-compose.pg18.yml

# 2. Generate secrets
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "COOKIE_SECRET=$(openssl rand -hex 32)" >> .env

# 3. Deploy
docker compose -f docker-compose.pg18.yml up -d
```

Open `http://localhost:3000` and connect your media server.

---

## Compose Files

| File                                    | Description                                      | RAM     | Setup       |
| --------------------------------------- | ------------------------------------------------ | ------- | ----------- |
| `docker-compose.pg18.yml`               | **Recommended** — PostgreSQL 18 + TimescaleDB HA | 1GB     | Secrets     |
| `docker-compose.example.yml`            | Standard — PostgreSQL 16                         | 1GB     | Secrets     |
| `docker-compose.supervised-example.yml` | All-in-one (Unraid bare metal only)              | **2GB** | Zero config |

---

## PostgreSQL 18 (Recommended)

**File:** `docker-compose.pg18.yml`

Uses PostgreSQL 18 with TimescaleDB HA image. Includes Toolkit extension for advanced analytics.

```bash
# Generate secrets
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "COOKIE_SECRET=$(openssl rand -hex 32)" >> .env

# Deploy
docker compose -f docker-compose.pg18.yml up -d
```

> **Note:** For new installations only. Data format is incompatible with PostgreSQL 15/16.

---

## Standard (PostgreSQL 16)

**File:** `docker-compose.example.yml`

Traditional multi-container setup with official TimescaleDB image.

```bash
# Generate secrets
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "COOKIE_SECRET=$(openssl rand -hex 32)" >> .env

# Deploy
docker compose -f docker-compose.example.yml up -d
```

---

## Supervised (Bare Metal Only)

**File:** `docker-compose.supervised-example.yml`

Single container with TimescaleDB, Redis, and Tracearr bundled. **Designed for Unraid bare metal hosts only** — not recommended for VMs or nested containers.

| Pros                         | Cons                              |
| ---------------------------- | --------------------------------- |
| Zero configuration           | Requires **2GB RAM** minimum      |
| Secrets auto-generated       | Less flexible for scaling         |
| Includes TimescaleDB Toolkit | Can't use existing infrastructure |

```bash
docker compose -f docker-compose.supervised-example.yml up -d
```

---

## Alternative Platforms

- **Unraid Community Apps** — Search "Tracearr" in the Apps tab
- **TrueNAS Apps** — Available in the app catalog
- **Proxmox VE** — Community helper script available

---

## Environment Variables

### Required (Standard/PG18 Only)

| Variable        | Description                 | Generate               |
| --------------- | --------------------------- | ---------------------- |
| `JWT_SECRET`    | Authentication token secret | `openssl rand -hex 32` |
| `COOKIE_SECRET` | Session cookie secret       | `openssl rand -hex 32` |

### Optional (All Deployments)

| Variable      | Default    | Description                              |
| ------------- | ---------- | ---------------------------------------- |
| `PORT`        | `3000`     | External port mapping                    |
| `TZ`          | `UTC`      | Timezone (e.g., `America/New_York`)      |
| `LOG_LEVEL`   | `info`     | Log verbosity (debug, info, warn, error) |
| `DB_PASSWORD` | `tracearr` | Database password (standard only)        |
| `CORS_ORIGIN` | `*`        | Allowed CORS origins                     |

### Supervised-Only

| Variable        | Default     | Description                                           |
| --------------- | ----------- | ----------------------------------------------------- |
| `PG_MAX_MEMORY` | Auto-detect | PostgreSQL memory limit (set if auto-detection fails) |

---

## Portainer Deployment

1. Go to **Stacks** → **Add Stack**
2. Name it `tracearr`
3. Choose **Web editor**
4. Paste contents of your chosen compose file
5. Add environment variables (if using standard/pg18):
   - `JWT_SECRET` = (generate with `openssl rand -hex 32`)
   - `COOKIE_SECRET` = (generate with `openssl rand -hex 32`)
6. Click **Deploy the stack**

---

## Updating

```bash
docker compose pull
docker compose up -d
```
