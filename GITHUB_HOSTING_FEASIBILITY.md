# GitHub Hosting Feasibility Summary

**Project:** Platform Signal  
**Review date:** July 25, 2026  
**Status:** Feasibility review only. No website, server, data, or deployment configuration was changed.

**Update (2026-07-27):** This review's "GitHub Pages plus a backend" and
"persistent Python service" options below have been superseded by a third
approach implemented directly in this repo: a scheduled GitHub Actions
workflow (`.github/workflows/flight-snapshot.yml`) runs the existing Python
tracker (`Flight_Data/realtime-flight-tracker/snapshot_batch.py`) every ~5
minutes, takes 10 snapshots 30 seconds apart (the same cadence
`PollingService` always used), and publishes them as one static
`data/flights-timeline.json` file. The static frontend
(`assets/js/integrated-flight-tracker.js`) replays those snapshots at a 30s
cadence, so the site still looks like a live 30s feed while GitHub Pages
serves nothing but static files and no external host is required. This keeps
OpenSky polling centralized to one Actions job every 5 minutes rather than
every 30 seconds, further reducing API/credential usage versus the original
architecture. See that workflow and script for the current implementation;
the remaining sections here describe the alternatives that were considered
and are kept for historical context.

## Executive Summary

The complete Platform Signal website cannot be hosted by **GitHub Pages alone** without losing its live flight and signal functions. GitHub Pages serves static files but cannot run the project's Python backend.

The website can be made public without changing its visible interface, calculations, maps, polling behavior, or data flow by using one of these architectures:

| Architecture | Preserves all functions? | Assessment |
|---|---:|---|
| GitHub Pages only | No | Cannot run the Python APIs or live tracker |
| GitHub Pages frontend plus a separate Python backend | Yes | Possible, but requires URL and CORS configuration |
| One persistent Python web service deployed from GitHub | Yes | Recommended; closest to the current local architecture |

The recommended solution is to keep GitHub as the source repository and automatic deployment source, while a persistent Python-capable web host runs the existing server and serves both the interface and APIs from one HTTPS address.

## Current Architecture

The browser interface depends on the Python backend for:

- `/api/flights`
- `/api/signal-v2`
- OpenSky OAuth authentication
- one centralized OpenSky request every 30 seconds
- one hour of in-memory flight and signal history
- inferred flight classification and signal calculations
- OpenFreeMap building-obstruction calculations
- protection of the OpenSky client secret

Relevant implementation files:

- [`Flight_Data/realtime-flight-tracker/server.py`](Flight_Data/realtime-flight-tracker/server.py)
- [`Flight_Data/realtime-flight-tracker/backend.py`](Flight_Data/realtime-flight-tracker/backend.py)
- [`Flight_Data/realtime-flight-tracker/v2_signal.py`](Flight_Data/realtime-flight-tracker/v2_signal.py)
- [`assets/js/integrated-flight-tracker.js`](assets/js/integrated-flight-tracker.js)

## Problems That Prevent Direct GitHub Pages Hosting

### 1. GitHub Pages Cannot Run the Python Backend

GitHub Pages supports static website files but does not support server-side Python. Consequently, publishing the repository directly would leave the live API URLs unavailable.

Without the backend, the website would lose live flights, one-hour history, Version 2 signal data, centralized OpenSky polling, and credential protection.

Reference: [GitHub Pages site documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)

### 2. Some Public URLs Exist Only Through Python Server Mappings

The current server maps public URLs to files stored elsewhere:

- `/assets/plane.glb` maps to `Flight_Data/DC8_AFRC_AIR_0824.glb`
- `/media/section-music.wav` maps to the selected music clip
- `/assets/subway.glb` maps to the centered subway model

These mappings are defined in `server.py`. Direct GitHub Pages publication would not recreate them automatically, so some models and media would return HTTP 404.

### 3. Project-Site URL Paths Would Be Incorrect

The likely GitHub Pages project address would be:

`https://industry-engagement.github.io/Platform_Signal/`

The interface currently contains root-relative URLs such as:

- `/api/flights`
- `/api/signal-v2`
- `/assets/plane.glb`
- `/assets/subway-centered.glb`

On a GitHub project site, these paths point to the organization site's root instead of the `/Platform_Signal/` project directory. A Pages-based deployment would require a configurable site base path and a configurable backend URL.

### 4. Required Runtime CSV Files Use Git LFS

The repository's `.gitattributes` applies Git LFS to CSV files. This includes small files required by the running website, such as:

- `Flight_Data/Rule/FrequencyMatching/lga_frequency_rules.csv`
- `Source/Subway_L.csv`
- `RouteShape/NYCSubways/SubwayDepth_L_Est.csv`

GitHub states that Git LFS cannot be used directly with GitHub Pages. A deployment must package ordinary runtime copies of the required small files or specifically store those runtime files outside LFS. Large source aviation datasets should remain excluded from the deployed website.

Reference: [GitHub LFS documentation](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage)

### 5. The Backend Is Stateful and Must Remain Running

Flight trails, finalized signal history, provisional predictions, and building caches are stored in process memory.

A hosting service that sleeps or restarts frequently would:

- clear the one-hour history;
- cause cold-start delays;
- temporarily interrupt the live API;
- rebuild caches after every restart.

The deployment should therefore use one persistent process and one replica. Multiple replicas would create separate histories and multiply OpenSky requests.

### 6. OpenSky Credentials Must Remain Secret

`Flight_Data/credentials.json` is correctly ignored by Git and excluded from the server's public-file allowlist. It must not be committed for deployment.

For cloud hosting, the backend should read the client ID and secret from the hosting provider's secret manager while retaining the current local `credentials.json` fallback. This changes credential delivery only, not website behavior.

### 7. OpenSky Quota and Permission Requirements

At one request every 30 seconds, one continuously running backend makes approximately:

`86,400 seconds per day / 30 seconds = 2,880 requests per day`

The current bounding box is under 25 square degrees, so the documented cost is approximately one OpenSky credit per request. One instance therefore uses approximately 2,880 credits per day. The documented standard authenticated allowance is 4,000 credits per day, but two instances would use approximately 5,760 credits and exceed that allowance.

Reference: [OpenSky REST API documentation](https://openskynetwork.github.io/opensky-api/rest.html)

OpenSky's current terms also state that operational REST API use in a live service requires a prior written agreement, including nonprofit operational use. This permission should be confirmed before public launch.

Reference: [OpenSky terms of use](https://opensky-network.org/about/terms-of-use)

### 8. Public Asset Rights Must Be Confirmed

Before public deployment, the project should confirm permission to distribute:

- the music clip;
- the aircraft 3D model;
- the subway 3D model;
- any other third-party media bundled with the public site.

This is not a coding problem, but it can affect whether the existing assets may be publicly hosted unchanged.

### 9. GitHub Pages Size and Build Limits

The full repository contains large aviation source files that the website does not need at runtime. Publishing the repository root would be inefficient and could expose unnecessary files.

A deployment workflow should create a curated runtime artifact containing only the interface, required route/source data, models, music clip, Python tracker, and rule files.

GitHub documents a 1 GB maximum published Pages site, a recommended 1 GB source-repository limit, and additional bandwidth/build limits.

Reference: [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)

## Recommended Behavior-Preserving Solution

Use one persistent Python web service connected to the GitHub repository:

1. GitHub remains the source of truth.
2. A push to the approved branch triggers deployment.
3. One Python process serves the existing interface and `/api` routes.
4. The hosting provider supplies HTTPS.
5. OpenSky credentials are stored as deployment secrets.
6. Only runtime files are included in the deployment.
7. The existing local `start-website.bat` workflow remains available.

This approach preserves same-origin URLs and avoids changing the browser/backend relationship.

## Alternative: GitHub Pages Plus a Backend

If the `github.io` address is specifically required:

1. A GitHub Actions workflow builds a static, runtime-only Pages artifact.
2. Virtual assets are copied into their expected public locations.
3. Root-relative asset paths become project-aware.
4. The API base address becomes configurable while retaining the local default.
5. A separate persistent Python service runs the tracker.
6. Backend CORS is restricted to the approved GitHub Pages domain.
7. Both sites use HTTPS.

GitHub supports branch-based or GitHub Actions-based Pages publication:

[Configuring a GitHub Pages publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## Functions That Must Remain Unchanged

Any deployment implementation should preserve:

- all existing interface IDs, controls, and event handlers;
- Plan, 3D, and Section views;
- subway routes, data, filters, and signal visualization;
- inferred probable/confirmed flight classification;
- 30-second centralized OpenSky polling;
- five-second browser reads from `/api/flights`;
- one-second provisional Version 2 advancement;
- one-hour finalized and provisional signal history;
- modeled frequency, FSPL, building loss, and total-loss calculations;
- click-only flight details;
- credential non-disclosure;
- current uncertainty and modeled/inferred labels.

## Information or Approval Needed Before Implementation

- Selection of the recommended single-service architecture or the Pages-plus-backend architecture.
- Access to a persistent Python-capable hosting account or Cornell-managed server.
- Confirmation that OpenSky permission covers public operational use.
- Confirmation of public-distribution rights for music and 3D assets.
- Optional custom-domain information.
- Explicit approval to modify deployment-related files.

The OpenSky client secret should not be sent through chat or committed to Git. It should be entered directly into the selected hosting provider's secret manager.

## Future Verification Checklist

After implementation approval, validation should include:

- Python unit tests;
- JavaScript and inline-script syntax checks;
- HTML ID and markup checks;
- local server smoke tests;
- public HTTPS health and API checks;
- verification that `credentials.json` returns HTTP 404;
- confirmation of one OpenSky poller and one deployed replica;
- browser checks of Plan, 3D, and Section views;
- live flight and Version 2 signal-history checks;
- Git diff and deployment-artifact inspection;
- confirmation that large source datasets are not published.

