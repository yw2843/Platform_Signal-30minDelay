/* global deck, maplibregl, THREE */

(function () {
  "use strict";

  var LGA = { longitude: -73.87260555, latitude: 40.77724222 };
  var COLORS = {
    probable: [245, 166, 35, 235],
    confirmed: [46, 212, 122, 240],
    selected: [255, 255, 255, 255]
  };

  var ui = {
    connection: document.getElementById("connection"),
    statusDot: document.getElementById("status-dot"),
    statusLabel: document.getElementById("status-label"),
    confirmedCount: document.getElementById("confirmed-count"),
    probableCount: document.getElementById("probable-count"),
    lastUpdate: document.getElementById("last-update"),
    subwayCount: document.getElementById("subway-count"),
    subwayLines: document.getElementById("subway-lines"),
    subwayUpdate: document.getElementById("subway-update"),
    flightPicker: document.getElementById("row-planes"),
    statusFilter: document.getElementById("flight-status-filter"),
    directionFilter: document.getElementById("flight-direction-filter"),
    detailsPanel: document.getElementById("details-panel"),
    detailsClose: document.getElementById("details-close"),
    detailsStatus: document.getElementById("details-status"),
    detailsCallsign: document.getElementById("details-callsign"),
    detailsRoute: document.getElementById("details-route"),
    detailsBody: document.getElementById("details-body"),
    detailsNote: document.getElementById("details-note"),
    signalRouteLegend: document.getElementById("flight-signal-route-legend"),
    signalScaleLabel: document.getElementById("flight-signal-scale-label"),
    loadingCard: document.getElementById("loading-card"),
    mapMessage: document.getElementById("map-message")
  };

  var state = {
    batch: null,
    previousBatch: null,
    displayedSnapshotAt: null,
    flights: [],
    selectedIcao24: null,
    statusVisibility: { confirmed: true, probable: true, noCurrent: true },
    directionFilter: "all",
    planOverlay: null,
    threeDOverlay: null,
    planSignalLayer: null,
    threeDSignalLayer: null,
    subwayRoutes3D: null,
    subwayStations3D: null,
    subwayStationsColor: null,
    activeSubwayRouteId: null,
    selectedTrainRouteId: null,
    selectedSignalHistory: [],
    selectedSignalProvisional: [],
    selectedSignalSince: null,
    selectedSignalWindowEnd: null,
    selectedSignalLoadingIcao24: null,
    selectedSignalSelectionVersion: 0,
    selectedSignalFocusedVersions: { plan: null, "3d": null },
    selectedSignalNoDataMessageVersion: null,
    messageTimer: null
  };

  var SIGNAL_ROUTE_WINDOW_SECONDS = 60 * 60;
  var SignalVisualScale = window.PlatformSignalVisualScale;
  var SIGNAL_STRENGTH_CONTRAST_EXPONENT = 3;
  var SIGNAL_RING_MIN_RADIUS_PX = 3;
  var SIGNAL_RING_MAX_RADIUS_PX = 48;
  var SIGNAL_RING_MIN_RADIUS_M = 15;
  var SIGNAL_RING_MAX_RADIUS_M = 500;
  var SIGNAL_RING_SEGMENTS = 20;
  var SIGNAL_FREQUENCY_COLORS = {
    "118.7": "#3264ff",
    "120.4": "#ef7d32",
    "120.8": "#8b5cf6",
    "121.7": "#18a36f"
  };
  var SIGNAL_FREQUENCY_UNKNOWN_COLOR = "#7d8790";

  // Draw regardless of what is already in the depth buffer, and never write depth.
  // NOTE: these are luma.gl v9 (WebGPU-style) parameter names. deck.gl v9 replaced the old
  // WebGL spelling -- `{depthTest: false}`, which these layers used to pass -- and silently
  // ignores it, so depth testing stayed ON. That defeated the draw-through-buildings intent
  // below AND made the casing/core ribbons z-fight, which rendered as dashes along the line.
  var DEPTH_ALWAYS = { depthCompare: "always", depthWriteEnabled: false };

  // Subway appearance is owned by the "Subway appearance" block in index.html, which runs
  // before this file loads. Reading those globals keeps one source of truth across Plan View
  // and 3D View -- notably the casing color, which used to live here as a hand-synced RGBA
  // copy of index.html's hex string. The fallbacks are the pre-consolidation literals, so
  // this file still renders sanely if it is ever loaded without index.html's script.
  function styleGlobal(name, fallback) {
    return typeof window[name] !== "undefined" ? window[name] : fallback;
  }
  var SUBWAY_OUTLINE_COLOR = styleGlobal("SubwayOutlineColorRgba", [242, 242, 242, 235]);
  var SUBWAY_LINE_WIDTH = styleGlobal("SubwayLineWidth3D", 6);
  var SUBWAY_LINE_WIDTH_SELECTED = styleGlobal("SubwayLineWidth3DSelected", 3);   // thinner while a train on this route is selected
  var SUBWAY_OUTLINE_WIDTH = styleGlobal("SubwayOutlineWidth3D", 9);
  var SUBWAY_OUTLINE_WIDTH_SELECTED = styleGlobal("SubwayOutlineWidth3DSelected", 16); // thicker while a train is selected
  var SUBWAY_DOT_RADIUS = styleGlobal("SubwayDotRadius3D", 4);
  var SUBWAY_DOT_RADIUS_MIN = styleGlobal("SubwayDotRadius3DMin", 2);
  var SUBWAY_DOT_STROKE_WIDTH = styleGlobal("SubwayDotStrokeWidth", 2);
  // Non-focused routes dim to this while another route/train/flight has focus -- the Plan
  // View equivalent is RouteDimColor + RouteDimOpacity in index.html (kept as a separate CSS
  // color + opacity pair there since MapLibre paint properties don't take RGBA arrays).
  var ROUTE_DIM_COLOR = [235, 239, 242, 41];   // light grey at 16% opacity
  var NORMAL_MODEL_COLOR = [255, 255, 255, 255];

  function hexToRgba(hex, alpha) {
    var value = parseInt(String(hex).replace("#", ""), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255, alpha];
  }

  // The 3D map has terrain enabled, so an ordinary MapLibre line layer for the
  // subway route gets depth-tested against extruded buildings and disappears
  // behind them. Rendering it as a deck.gl layer with depth testing off (DEPTH_ALWAYS) paints it
  // regardless of what's already in the depth buffer, keeping it visible
  // through buildings. Data comes from index.html's broadcast (see
  // "platform:three-d-subway-routes-updated" below) rather than a fetch here,
  // since index.html already owns loading/reprojecting the route shapes.
  function makeThreeDSubwayLayer() {
    if (!state.subwayRoutes3D || !state.subwayRoutes3D.features.length) return makeThreeDStationLayer();
    // A route reads as highlighted when a train on it is selected OR when its button is the
    // focused line in the Route Filters panel (see setActiveRoute in index.html).
    function isSelected(feature) {
      var id = feature.properties.routeId;
      return id === state.selectedTrainRouteId || id === state.activeSubwayRouteId;
    }
    function isDimmed(feature) {
      return routeFocusExists() && !isSelected(feature);
    }
    function selectRouteFromMap(info) {
      var feature = info && info.object;
      var routeId = feature && feature.properties && feature.properties.routeId;
      if (!routeId) return;
      // The live-train circles are native MapLibre layers above this deck.gl route. When a
      // train overlaps the casing, let its more specific click handler win instead of also
      // selecting the route underneath it.
      var map = window.ThreeDView && window.ThreeDView.getMap();
      if (map && map.getLayer("three-d-live-trains") &&
          Number.isFinite(Number(info.x)) && Number.isFinite(Number(info.y)) &&
          map.queryRenderedFeatures([Number(info.x), Number(info.y)], {
            layers: ["three-d-live-trains"]
          }).length) return;
      document.dispatchEvent(new CustomEvent("platform:subway-route-clicked", {
        detail: { route: routeId }
      }));
    }
    // lineBillboard extrudes each ribbon in SCREEN space rather than in the ground plane
    // (GeoJsonLayer's name for PathLayer's `billboard`). Without it the pixel width is only
    // correct viewed straight down, so an oblique 3D camera foreshortens the line until it
    // reads as a flat decal painted on the terrain. Billboarded, the ribbon always faces the
    // camera and holds its width from any angle, and the casing stays registered around the
    // colored core so the outline survives. Safe here because every route grade is under 3%;
    // billboarding only misbehaves on near-vertical paths.
    // Order IS z-order here: every subway layer uses DEPTH_ALWAYS, so nothing occludes
    // anything and painting order alone decides. Station dots go LAST so they sit in front
    // of the lines they belong to.
    return [
      // Thin light-grey casing underneath every route line; thickens when a train on
      // that route is selected (mirrors setRouteHighlighted() for Plan View in index.html).
      new deck.GeoJsonLayer({
        id: "three-d-subway-lines-casing",
        data: state.subwayRoutes3D,
        getLineColor: function (feature) { return isDimmed(feature) ? ROUTE_DIM_COLOR : SUBWAY_OUTLINE_COLOR; },
        getLineWidth: function (feature) { return isSelected(feature) ? SUBWAY_OUTLINE_WIDTH_SELECTED : SUBWAY_OUTLINE_WIDTH; },
        lineWidthUnits: "pixels",
        lineBillboard: true,
        lineJointRounded: true,
        lineCapRounded: true,
        pickable: true,
        onClick: selectRouteFromMap,
        // depthBias pushes the casing away from the camera so the colored core always wins
        // the depth comparison. Belt-and-braces alongside DEPTH_ALWAYS: the two ribbons share
        // one centerline, so without separation they are coplanar and z-fight, which showed
        // up as the core breaking through the casing in dashes.
        parameters: Object.assign({ depthBias: 1, depthBiasSlopeScale: 1 }, DEPTH_ALWAYS),
        updateTriggers: {
          getLineColor: [state.selectedIcao24, state.selectedTrainRouteId, state.activeSubwayRouteId],
          getLineWidth: [state.selectedTrainRouteId, state.activeSubwayRouteId]
        }
      }),
      new deck.GeoJsonLayer({
        id: "three-d-subway-lines",
        data: state.subwayRoutes3D,
        getLineColor: function (feature) {
          return isDimmed(feature) ? ROUTE_DIM_COLOR : hexToRgba(feature.properties.color, 235);
        },
        getLineWidth: function (feature) { return isSelected(feature) ? SUBWAY_LINE_WIDTH_SELECTED : SUBWAY_LINE_WIDTH; },
        lineWidthUnits: "pixels",
        lineBillboard: true,
        lineJointRounded: true,
        lineCapRounded: true,
        pickable: false,
        parameters: DEPTH_ALWAYS,
        updateTriggers: {
          getLineColor: [state.selectedIcao24, state.selectedTrainRouteId, state.activeSubwayRouteId],
          getLineWidth: [state.selectedTrainRouteId, state.activeSubwayRouteId]
        }
      })
    ].concat(makeThreeDStationLayer());
  }

  // Station dots for the focused line, broadcast by syncActiveStationDots in index.html.
  // Same DEPTH_ALWAYS treatment as the route lines so terrain/buildings can't hide them.
  function makeThreeDStationLayer() {
    if (!state.subwayStations3D || !state.subwayStations3D.features.length) return [];
    return [
      new deck.GeoJsonLayer({
        id: "three-d-subway-stations",
        data: state.subwayStations3D,
        pointType: "circle",
        pointRadiusUnits: "pixels",
        getPointRadius: SUBWAY_DOT_RADIUS,
        pointRadiusMinPixels: SUBWAY_DOT_RADIUS_MIN,
        getFillColor: SUBWAY_OUTLINE_COLOR,
        getLineColor: hexToRgba(state.subwayStationsColor || "#f2f2f2", 255),
        stroked: true,
        lineWidthUnits: "pixels",
        getLineWidth: SUBWAY_DOT_STROKE_WIDTH,
        pickable: false,
        parameters: DEPTH_ALWAYS,
        updateTriggers: { getLineColor: state.subwayStationsColor }
      })
    ];
  }

  function filteredFlights() {
    return state.flights.filter(function (flight) {
      if (!flight.active) return false;
      var statusMatches = state.statusVisibility[flight.status] === true;
      var signalMatches = hasCurrentModeledSignal(flight) || state.statusVisibility.noCurrent;
      var directionMatches = state.directionFilter === "all" || flight.direction === state.directionFilter;
      return statusMatches && signalMatches && directionMatches;
    });
  }

  function routeFocusExists() {
    return !!(state.selectedIcao24 || state.activeSubwayRouteId || state.selectedTrainRouteId);
  }

  function attachOverlay(map, mode) {
    var property = mode === "plan" ? "planOverlay" : "threeDOverlay";
    if (!map || state[property]) return;
    addBoundaryLayers(map, mode);
    ensureSelectedSignalLayer(map, mode);
    var overlay = new deck.MapboxOverlay({
      // Plan already has a Three.js custom layer sharing MapLibre's WebGL context.
      // Giving deck.gl a separate canvas there prevents the two renderers from
      // clearing each other's framebuffer. Keep interleaving in 3D for depth-aware
      // flight geometry against the extruded map layers.
      interleaved: mode === "3d",
      layers: [],
      getTooltip: function (info) {
        var object = info.object;
        if (!object) return null;
        if (object.properties && object.properties.routeId) {
          return object.properties.routeId + " Route";
        }
        return object.icao24 ? tooltipText(object) : null;
      }
    });
    map.addControl(overlay);
    state[property] = overlay;
    updateFlightLayers();
    if (mode === "plan") {
      // Flight trails/planes and the boundary ring just landed on top of the
      // Plan map's layer stack (deck.gl's interleaved overlay has no beforeId,
      // so it renders above everything by default). Subway lines must stay
      // visually in front of that regardless of load order, so push them back
      // to the top now. (The 3D map doesn't need this -- its subway line is a
      // depth-test-disabled deck.gl layer, see makeThreeDSubwayLayer below.)
      if (window.PlanView && typeof window.PlanView.bringSubwayToFront === "function") {
        window.PlanView.bringSubwayToFront();
      }
    }
  }

  function addBoundaryLayers(map, mode) {
    var prefix = mode === "plan" ? "plan-flight-" : "three-d-flight-";
    if (!map.getSource(prefix + "boundary")) {
      map.addSource(prefix + "boundary", {
        type: "geojson",
        data: circleFeature(LGA.longitude, LGA.latitude, 40, 160)
      });
      map.addLayer({
        id: prefix + "boundary-fill",
        type: "fill",
        source: prefix + "boundary",
        paint: { "fill-color": "#6dc8ff", "fill-opacity": 0.035 }
      });
      map.addLayer({
        id: prefix + "boundary-line",
        type: "line",
        source: prefix + "boundary",
        paint: {
          "line-color": "#42a9e6",
          "line-width": 1.4,
          "line-opacity": 0.8,
          "line-dasharray": [3, 2]
        }
      });
    }
    if (!map.getSource(prefix + "airport")) {
      map.addSource(prefix + "airport", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "Point", coordinates: [LGA.longitude, LGA.latitude] },
          properties: {}
        }
      });
      map.addLayer({
        id: prefix + "airport-marker",
        type: "circle",
        source: prefix + "airport",
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#0b1928",
          "circle-stroke-width": 2
        }
      });
    }
  }

  function makeFlightLayers(mode) {
    var flights = filteredFlights();
    var activeFlights = flights.filter(function (flight) { return flight.active; });
    var probable = flights.filter(function (flight) {
      return flight.status === "probable" && flight.track && flight.track.length > 1;
    });
    var confirmed = flights.filter(function (flight) {
      return flight.status === "confirmed" && flight.track && flight.track.length > 1;
    });
    var is3D = mode === "3d";
    var prefix = is3D ? "three-d-" : "plan-";
    // The GLB has a 0.01 root transform, so a unit scale makes its silhouette
    // only a few pixels wide at the map's normal zoom levels. Keep the model
    // comfortably visible, with extra size in the foreshortened 3D view.
    var aircraftModelScale = is3D ? 8 : 6;
    var onPick = function (info) {
      if (info && info.object) selectFlight(info.object.icao24);
    };

    function flightPath(flight) {
      return flight.track.map(function (point) {
        return [point.longitude, point.latitude, is3D ? Number(point.altitude_m || 0) : 0];
      });
    }
    function flightPosition(flight) {
      var current = flight.current;
      if (flight.icao24 === state.selectedIcao24 && flight.signal_v2 && flight.signal_v2.live_current) {
        var live = flight.signal_v2.live_current;
        if (finiteNumber(live.aircraft_lon) != null && finiteNumber(live.aircraft_lat) != null) {
          return [Number(live.aircraft_lon), Number(live.aircraft_lat),
            is3D ? Math.max(0, Number(live.aircraft_altitude_m) || 0) : 0];
        }
      }
      return [current.longitude, current.latitude, is3D ? Number(current.altitude_m || 0) : 0];
    }
    function flightHeading(flight) {
      var current = flight.current;
      if (flight.icao24 === state.selectedIcao24 && flight.signal_v2 && flight.signal_v2.live_current &&
          finiteNumber(flight.signal_v2.live_current.heading_deg) != null) {
        return Number(flight.signal_v2.live_current.heading_deg);
      }
      return Number(current.heading_deg || 0);
    }

    var layers = [
      new deck.PathLayer({
        id: prefix + "confirmed-flight-trails",
        data: confirmed,
        getPath: flightPath,
        getColor: function (flight) {
          if (flight.icao24 === state.selectedIcao24) return COLORS.selected;
          return routeFocusExists() ? ROUTE_DIM_COLOR : COLORS.confirmed;
        },
        getWidth: function (flight) { return flight.icao24 === state.selectedIcao24 ? 5 : 3; },
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 140],
        onClick: onPick,
        updateTriggers: {
          getColor: [state.selectedIcao24, state.activeSubwayRouteId, state.selectedTrainRouteId],
          getWidth: state.selectedIcao24
        }
      }),
      new deck.PathLayer({
        id: prefix + "probable-flight-trails",
        data: probable,
        getPath: flightPath,
        getColor: function (flight) {
          if (flight.icao24 === state.selectedIcao24) return COLORS.selected;
          return routeFocusExists() ? ROUTE_DIM_COLOR : COLORS.probable;
        },
        getWidth: function (flight) { return flight.icao24 === state.selectedIcao24 ? 5 : 3; },
        getDashArray: [3, 2],
        dashJustified: true,
        dashGapPickable: true,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 140],
        extensions: [new deck.PathStyleExtension({ dash: true })],
        onClick: onPick,
        updateTriggers: {
          getColor: [state.selectedIcao24, state.activeSubwayRouteId, state.selectedTrainRouteId],
          getWidth: state.selectedIcao24
        }
      })
    ];
    layers.push(
      new deck.ScatterplotLayer({
        id: prefix + "flight-status-halos",
        data: activeFlights,
        getPosition: flightPosition,
        getRadius: 8,
        radiusUnits: "pixels",
        getFillColor: function (flight) {
          return flight.icao24 !== state.selectedIcao24 && routeFocusExists()
            ? ROUTE_DIM_COLOR
            : statusColor(flight, 115);
        },
        getLineColor: function (flight) {
          if (flight.icao24 === state.selectedIcao24) return COLORS.selected;
          return routeFocusExists() ? ROUTE_DIM_COLOR : statusColor(flight, 255);
        },
        lineWidthUnits: "pixels",
        getLineWidth: function (flight) { return flight.icao24 === state.selectedIcao24 ? 3 : 1.5; },
        stroked: true,
        pickable: true,
        onClick: onPick,
        updateTriggers: {
          getFillColor: [state.selectedIcao24, state.activeSubwayRouteId, state.selectedTrainRouteId],
          getLineColor: [state.selectedIcao24, state.activeSubwayRouteId, state.selectedTrainRouteId],
          getLineWidth: state.selectedIcao24
        }
      }),
      new deck.ScenegraphLayer({
        id: prefix + "dc8-aircraft-models",
        data: activeFlights,
        scenegraph: "Flight_Data/DC8_AFRC_AIR_0824.glb",
        getPosition: flightPosition,
        getOrientation: function (flight) { return [0, flightHeading(flight), 90]; },
        getColor: function (flight) {
          return flight.icao24 !== state.selectedIcao24 && routeFocusExists()
            ? ROUTE_DIM_COLOR
            : NORMAL_MODEL_COLOR;
        },
        getScale: [aircraftModelScale, aircraftModelScale, aircraftModelScale],
        sizeScale: 1,
        sizeMinPixels: 10,
        sizeMaxPixels: is3D ? 58 : 32,
        _lighting: "pbr",
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 100],
        onClick: onPick,
        updateTriggers: {
          getColor: [state.selectedIcao24, state.activeSubwayRouteId, state.selectedTrainRouteId]
        }
      })
    );
    return layers;
  }

  function updateFlightLayers() {
    if (state.planOverlay) {
      state.planOverlay.setProps({ layers: makeFlightLayers("plan") });
    }
    if (state.threeDOverlay) {
      // Array order is z-order. Subway routes go FIRST so flight trails/planes paint on top of
      // them -- flight routes were previously being hidden underneath the subway lines.
      state.threeDOverlay.setProps({
        layers: makeThreeDSubwayLayer().concat(makeFlightLayers("3d"))
      });
      // The subway layers above register as native layers and can land above the live
      // train dots' native circle layer -- reassert that trains render on top of them.
      if (window.ThreeDView && typeof window.ThreeDView.bringLiveTrainsToFront === "function") {
        window.ThreeDView.bringLiveTrainsToFront();
      }
    }
    updateSelectedSignalGeometry();
  }

  function statusColor(flight, alpha) {
    var color = flight.status === "confirmed" ? COLORS.confirmed : COLORS.probable;
    return [color[0], color[1], color[2], alpha];
  }

  function tooltipText(flight) {
    var call = flight.callsign || flight.icao24.toUpperCase();
    return call + " - " + capitalize(flight.status) + " " + flight.direction + " - " +
      formatNumber(flight.current.distance_nm, 1, " NM");
  }

  // GitHub Pages cannot run the live Python tracker, so instead of polling a
  // "/api/flights" API every few seconds, the frontend fetches a batch of
  // pre-recorded snapshots. GitHub's own schedule trigger does not reliably
  // fire every few minutes (observed delays of 20+ minutes), so a GitHub
  // Actions workflow instead asks for a run every 25 minutes, and each run
  // records a full 30-minute window of snapshots 30 seconds apart -- see
  // Flight_Data/realtime-flight-tracker/snapshot_batch.py. The frontend
  // always displays what happened DISPLAY_LAG_SECONDS ago and ticks forward
  // with the wall clock (not a frame counter), so as long as a fresh
  // 30-minute batch lands within any 30-minute gap between runs, playback
  // never runs dry the way a fixed "start of this batch" index did.
  var BATCH_URL = "data/flights-timeline.json";
  var DISPLAY_LAG_SECONDS = 30 * 60;
  // How much further behind DISPLAY_LAG_SECONDS the newest available data is
  // allowed to be before the status bar flags the feed as stalled, rather
  // than silently holding the last known snapshot forever.
  var STALE_GRACE_SECONDS = 15 * 60;

  function mergedSnapshots() {
    var combined = [];
    if (state.previousBatch) combined = combined.concat(state.previousBatch.snapshots || []);
    if (state.batch) combined = combined.concat(state.batch.snapshots || []);
    combined.sort(function (a, b) { return Number(a.generated_at) - Number(b.generated_at); });
    return combined;
  }

  function currentSnapshot() {
    var combined = mergedSnapshots();
    if (!combined.length) return null;
    var targetTime = Date.now() / 1000 - DISPLAY_LAG_SECONDS;
    var selected = null;
    combined.some(function (snapshot) {
      if (Number(snapshot.generated_at) > targetTime) return true;
      selected = snapshot;
      return false;
    });
    // Before the site has accumulated a full 30 minutes of history (e.g. right
    // after a first-ever page load), show the oldest snapshot we do have and
    // let the wall clock catch up to it rather than showing nothing.
    return selected || combined[0];
  }

  function pipelineIsStale() {
    var combined = mergedSnapshots();
    if (!combined.length) return true;
    var newest = combined[combined.length - 1];
    return (Date.now() / 1000 - Number(newest.generated_at)) > (DISPLAY_LAG_SECONDS + STALE_GRACE_SECONDS);
  }

  function applyCurrentSnapshot() {
    var snapshot = currentSnapshot();
    if (!snapshot) {
      setConnection("waiting", "Waiting for the first snapshot batch");
      return;
    }
    if (snapshot.generated_at !== state.displayedSnapshotAt) {
      state.displayedSnapshotAt = snapshot.generated_at;
      state.flights = snapshot.flights || [];
      advanceSignalClock();
      renderStatus(snapshot);
      renderFlightButtons();
      updateFlightLayers();
      refreshSelectedFlight();
    }
    if (pipelineIsStale()) {
      setConnection("waiting", "Waiting for update");
    }
  }

  async function fetchBatch() {
    try {
      var response = await fetch(BATCH_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!response.ok) throw new Error("Snapshot batch returned HTTP " + response.status);
      var payload = await response.json();
      if (!payload || !Array.isArray(payload.snapshots) || !payload.snapshots.length) return;
      if (!state.batch || payload.batch_generated_at > state.batch.batch_generated_at) {
        state.previousBatch = state.batch;
        state.batch = payload;
      }
      applyCurrentSnapshot();
    } catch (error) {
      setConnection("error", "Snapshot feed unavailable");
      showMessage(error.message || String(error));
    }
  }

  function getSignalHistory(icao24, since) {
    var key = String(icao24 || "").toLowerCase();
    var cached =
      (state.batch && state.batch.signal_histories && state.batch.signal_histories[key]) ||
      (state.previousBatch && state.previousBatch.signal_histories && state.previousBatch.signal_histories[key]);
    if (!cached) return null;
    return {
      version: cached.version,
      icao24: cached.icao24,
      since: since,
      finalized_through: cached.finalized_through,
      points: (cached.points || []).filter(function (point) {
        return since == null || Number(point.timestamp) > Number(since);
      })
    };
  }

  window.PlatformSignalBatch = { getSignalHistory: getSignalHistory };

  function selectSignalPoint(flight, nowSeconds) {
    var signal = flight.signal_v2;
    if (!signal) return null;
    var selected = signal.current || null;
    (signal.predicted_timeline || []).some(function (point) {
      if (Number(point.timestamp) > nowSeconds) return true;
      selected = point;
      return false;
    });
    return selected;
  }

  function advanceSignalClock() {
    var nowSeconds = Date.now() / 1000;
    var ticks = [];
    state.flights.forEach(function (flight) {
      if (!flight.signal_v2) return;
      flight.signal_v2.live_current = selectSignalPoint(flight, nowSeconds);
      if (flight.signal_v2.live_current) {
        ticks.push({
          icao24: flight.icao24,
          signal: flight.signal_v2.live_current
        });
      }
    });
    window.dispatchEvent(new CustomEvent("platform:flight-signal-v2-tick", {
      detail: { generatedAt: nowSeconds, flights: ticks }
    }));
    if (state.selectedIcao24) {
      var selectedFlight = state.flights.find(function (flight) {
        return flight.icao24 === state.selectedIcao24;
      });
      if (selectedFlight) {
        syncSelectedSignalRoute(selectedFlight, false);
        updateFlightLayers();
      }
    }
    if (state.selectedIcao24 && ui.detailsPanel.classList.contains("open")) {
      var selected = state.flights.find(function (flight) {
        return flight.icao24 === state.selectedIcao24;
      });
      if (selected) renderDetails(selected);
    }
  }

  function renderStatus(payload) {
    var service = payload.service || {};
    var activeFlights = state.flights.filter(function (flight) { return flight.active; });
    var label = service.state === "online" ? "Live" : capitalize(service.state || "starting");
    setConnection(service.state, label);
    ui.confirmedCount.textContent = activeFlights.filter(function (flight) {
      return flight.status === "confirmed";
    }).length;
    ui.probableCount.textContent = activeFlights.filter(function (flight) {
      return flight.status === "probable";
    }).length;
    ui.lastUpdate.textContent = payload.source_time ? formatClock(payload.source_time * 1000) : "--";
    ui.loadingCard.classList.toggle("hidden", Boolean(payload.source_time));
    var displayedAgeMinutes = payload.generated_at != null
      ? Math.round((Date.now() / 1000 - payload.generated_at) / 60)
      : null;
    ui.connection.title = [
      service.message,
      service.remaining_credits != null ? service.remaining_credits + " state credits remaining" : "",
      "Replayed from a GitHub Actions snapshot batch, refreshed roughly every 25 min" +
        (displayedAgeMinutes != null ? " (showing data ~" + displayedAgeMinutes + " min behind live)" : "")
    ].filter(Boolean).join(" - ");
  }

  function setConnection(status, label) {
    ui.statusDot.className = "status-dot";
    if (status === "online") ui.statusDot.classList.add("online");
    if (status === "error") ui.statusDot.classList.add("error");
    ui.statusLabel.textContent = label;
  }

  function renderFlightButtons() {
    var flights = filteredFlights();
    if (typeof window.setSectionOverviewFlights === "function") {
      window.setSectionOverviewFlights(flights);
    }
    ui.flightPicker.replaceChildren();
    if (!flights.length) {
      var empty = document.createElement("span");
      empty.className = "filter-placeholder";
      empty.textContent = state.flights.length ? "No live flights match these filters" : "Waiting for classified flights...";
      ui.flightPicker.appendChild(empty);
      return;
    }
    flights.forEach(function (flight) {
      var signalAvailability = currentSignalAvailability(flight);
      var button = document.createElement("button");
      button.type = "button";
      button.className = "route-btn pill flight-" + flight.status;
      if (!signalAvailability.drawable) button.classList.add("flight-signal-unavailable");
      if (flight.icao24 === state.selectedIcao24) button.classList.add("active-flight");
      button.textContent = flight.callsign || flight.icao24.toUpperCase();
      button.title = capitalize(flight.status) + " " + flight.direction + " - " +
        formatNumber(flight.current.distance_nm, 1, " NM from LGA") + " - " +
        signalAvailability.reason;
      if (!signalAvailability.drawable) {
        var signalBadge = document.createElement("span");
        signalBadge.className = "flight-signal-state";
        signalBadge.textContent = "No current modeled signal";
        button.appendChild(signalBadge);
      }
      button.addEventListener("click", function () { selectFlight(flight.icao24); });
      ui.flightPicker.appendChild(button);
    });
  }

  function selectFlight(icao24) {
    var isNewSelection = state.selectedIcao24 !== icao24;
    if (isNewSelection) resetSelectedSignalRoute();
    state.selectedIcao24 = icao24;
    var flight = state.flights.find(function (item) { return item.icao24 === icao24; });
    if (!flight) return;
    // Synchronous: index.html's listener runs and clears any selected train
    // (closing the panel) before the lines below reopen it for this flight.
    document.dispatchEvent(new CustomEvent("platform:flight-selected", { detail: { icao24: icao24 } }));
    renderDetails(flight);
    renderFlightButtons();
    ui.detailsPanel.classList.add("open");
    ui.detailsPanel.setAttribute("aria-hidden", "false");
    syncSelectedSignalRoute(flight, true);
    var signalAvailability = currentSignalAvailability(flight);
    var callsign = flight.callsign || flight.icao24.toUpperCase();
    if (isNewSelection) {
      showMessage(signalAvailability.drawable
        ? callsign + ": loading and framing the selected one-hour signal route..."
        : callsign + ": current signal unavailable (" + signalAvailability.reason.toLowerCase() +
          "); checking the rolling one-hour route.");
    } else {
      focusSelectedSignalRoute(activeViewMode(), true);
    }
    if (window.setActiveSectionFlight) window.setActiveSectionFlight(flight);
    updateFlightLayers();
  }

  function closeDetails() {
    state.selectedIcao24 = null;
    resetSelectedSignalRoute();
    ui.detailsPanel.classList.remove("open");
    ui.detailsPanel.setAttribute("aria-hidden", "true");
    if (ui.detailsPanel.dataset.detailsOwner === "flight") delete ui.detailsPanel.dataset.detailsOwner;
    renderFlightButtons();
    if (window.setActiveSectionFlight) window.setActiveSectionFlight(null);
    updateFlightLayers();
  }

  function refreshSelectedFlight() {
    if (!state.selectedIcao24) return;
    var flight = state.flights.find(function (item) { return item.icao24 === state.selectedIcao24; });
    if (!flight) {
      closeDetails();
      return;
    }
    if (!flight.active) {
      var callsign = flight.callsign || flight.icao24.toUpperCase();
      closeDetails();
      showMessage(callsign + " is no longer live, so its signal route has been cleared.");
      return;
    }
    if (!selectedFlightPassesFilters()) {
      closeDetails();
      return;
    }
    renderDetails(flight);
    syncSelectedSignalRoute(flight, true);
    if (window.setActiveSectionFlight) window.setActiveSectionFlight(flight);
  }

  function renderDetails(flight) {
    ui.detailsPanel.dataset.detailsOwner = "flight";
    var signal = flight.signal_v2
      ? (flight.signal_v2.live_current || flight.signal_v2.current)
      : null;
    ui.detailsStatus.textContent = "";
    ui.detailsStatus.hidden = true;
    ui.detailsStatus.style.color = "#8fc7ff";
    ui.detailsCallsign.textContent = flight.callsign || flight.icao24.toUpperCase();
    ui.detailsRoute.textContent = "";
    ui.detailsRoute.hidden = true;

    var rows = [];
    if (signal) {
      var buildingPath = "Unavailable - FSPL only";
      if (signal.building_data_status === "available" || signal.building_data_status === "partial") {
        buildingPath = signal.building_blocked
          ? "Blocked - " + (signal.blocking_building_count || 1) + " blocking"
          : "Clear";
        if (signal.building_data_status === "partial") buildingPath += " (partial data)";
      }
      rows.push(
        ["ICAO24", String(signal.icao24 || flight.icao24).toUpperCase()],
        ["Signal point", label(signal.position_status)],
        ["Phase", label(signal.inferred_phase)],
        ["Phase confidence", formatNumber(Number(signal.phase_confidence) * 100, 0, "%")],
        ["Service", signal.service ? label(signal.service) : "--"],
        ["Frequency", formatNumber(signal.most_likely_frequency_mhz, 1, " MHz")],
        ["Frequency assignment", label(signal.frequency_assignment_status)],
        ["Matched V2 rule", signal.matched_rule_id || "--"],
        ["Slant distance", formatNumber(signal.slant_distance_km, 2, " km")],
        ["Modeled total loss", formatNumber(signal.total_loss_db, 2, " dB")],
        ["Change vs phase strongest", formatSigned(signal.relative_signal_phase_db, 2, " dB")],
        ["Phase relative power", formatNumber(signal.relative_power_phase_percent, 1, "%")],
        ["Change vs flight strongest", formatSigned(signal.relative_signal_flight_db, 2, " dB")],
        ["Flight relative power", formatNumber(signal.relative_power_flight_percent, 1, "%")],
        ["Free-space loss", formatNumber(signal.fspl_db, 2, " dB")],
        ["Building loss", formatNumber(signal.building_loss_db, 2, " dB")],
        ["Building path", buildingPath],
        ["Building calculation", label(signal.building_calculation_status)],
        ["Signal time", formatDateTime(signal.timestamp)]
      );
    } else {
      rows.push(["V2 signal", "Waiting for an eligible phase and position"]);
    }
    ui.detailsBody.replaceChildren.apply(ui.detailsBody, rows.map(function (row) {
      return detailRow(row[0], row[1]);
    }));
    if (!signal || signal.frequency_assignment_status === "unavailable") {
      ui.detailsNote.textContent = "V2 has no valid phase/frequency assignment, so signal loss is not calculated.";
    } else if (signal.frequency_assignment_status === "outside_40_nm") {
      ui.detailsNote.textContent = "The V2 point is beyond 40 NM. No frequency or signal loss is assigned.";
    } else if (signal.frequency_assignment_status === "held_during_transition") {
      ui.detailsNote.textContent = "The frequency is temporarily held from the last stable V2 phase. It will clear after two consecutive unmatched actual observations.";
    } else {
      ui.detailsNote.textContent = "V2 values are modeled path loss, not measured dBm. Lower total loss is stronger; 0 dB relative change is the strongest modeled point in the selected phase or flight.";
    }
  }

  function finiteNumber(value) {
    if (value == null || value === "") return null;
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function mergeSignalPoints(existing, incoming) {
    var byTimestamp = {};
    existing.concat(incoming || []).forEach(function (point) {
      var timestamp = finiteNumber(point && point.timestamp);
      if (timestamp != null) byTimestamp[String(timestamp)] = point;
    });
    return Object.keys(byTimestamp).map(function (key) {
      return byTimestamp[key];
    }).sort(function (a, b) {
      return Number(a.timestamp) - Number(b.timestamp);
    });
  }

  function trimSelectedSignalRoute(windowEndSeconds) {
    var cutoff = windowEndSeconds - SIGNAL_ROUTE_WINDOW_SECONDS;
    state.selectedSignalHistory = state.selectedSignalHistory.filter(function (point) {
      return Number(point.timestamp) >= cutoff;
    });
    state.selectedSignalProvisional = state.selectedSignalProvisional.filter(function (point) {
      return Number(point.timestamp) >= cutoff;
    });
  }

  function resetSelectedSignalRoute() {
    state.selectedSignalHistory = [];
    state.selectedSignalProvisional = [];
    state.selectedSignalSince = null;
    state.selectedSignalWindowEnd = null;
    state.selectedSignalLoadingIcao24 = null;
    state.selectedSignalSelectionVersion += 1;
    state.selectedSignalNoDataMessageVersion = null;
    setSignalLegendVisible(false);
  }

  function setSignalLegendVisible(visible) {
    if (!ui.signalRouteLegend) return;
    ui.signalRouteLegend.classList.toggle("visible", Boolean(visible));
    ui.signalRouteLegend.setAttribute("aria-hidden", String(!visible));
  }

  function syncSelectedSignalRoute(flight, loadHistory) {
    if (!flight || flight.icao24 !== state.selectedIcao24 || !flight.signal_v2) return;
    var signal = flight.signal_v2;
    var provisional = [];
    if (signal.current) provisional.push(signal.current);
    provisional = provisional.concat(signal.predicted_timeline || []);
    var finalizedThrough = finiteNumber(signal.finalized_through);
    if (finalizedThrough != null) {
      state.selectedSignalWindowEnd = Math.max(
        state.selectedSignalWindowEnd == null ? finalizedThrough : state.selectedSignalWindowEnd,
        finalizedThrough
      );
      provisional = provisional.filter(function (point) {
        return Number(point.timestamp) > finalizedThrough;
      });
    }
    state.selectedSignalProvisional = mergeSignalPoints([], provisional);
    trimSelectedSignalRoute(state.selectedSignalWindowEnd || Date.now() / 1000);
    setSignalLegendVisible(drawableSelectedSignalPoints().length >= 2);
    if (loadHistory) loadSelectedSignalHistory();
  }

  function loadSelectedSignalHistory() {
    if (!state.selectedIcao24) return;
    var icao24 = String(state.selectedIcao24).toLowerCase();
    if (state.selectedSignalLoadingIcao24 === icao24) return;
    var selectionVersion = state.selectedSignalSelectionVersion;
    var since = state.selectedSignalSince;
    if (since == null) {
      since = (state.selectedSignalWindowEnd || Date.now() / 1000) - SIGNAL_ROUTE_WINDOW_SECONDS - 2;
    }
    state.selectedSignalLoadingIcao24 = icao24;
    Promise.resolve(getSignalHistory(icao24, since))
      .then(function (payload) {
        if (!payload) throw new Error("Signal history unavailable for " + icao24);
        return payload;
      })
      .then(function (payload) {
        if (String(state.selectedIcao24 || "").toLowerCase() !== icao24 ||
            selectionVersion !== state.selectedSignalSelectionVersion) return;
        var incoming = payload.points || [];
        state.selectedSignalHistory = mergeSignalPoints(state.selectedSignalHistory, incoming);
        var finalizedThrough = finiteNumber(payload.finalized_through);
        if (finalizedThrough != null) {
          state.selectedSignalSince = finalizedThrough;
          state.selectedSignalWindowEnd = Math.max(
            state.selectedSignalWindowEnd == null ? finalizedThrough : state.selectedSignalWindowEnd,
            finalizedThrough
          );
          state.selectedSignalProvisional = state.selectedSignalProvisional.filter(function (point) {
            return Number(point.timestamp) > finalizedThrough;
          });
        }
        trimSelectedSignalRoute(state.selectedSignalWindowEnd || Date.now() / 1000);
        updateFlightLayers();
        resolveSelectedSignalFocus(selectionVersion);
      })
      .catch(function (error) {
        if (window.console && console.warn) console.warn("Selected signal route unavailable:", error);
        if (selectionVersion === state.selectedSignalSelectionVersion) {
          if (!focusSelectedSignalRoute(activeViewMode())) {
            showMessage("The selected signal-route history could not be loaded. Try selecting the flight again.");
          }
        }
      })
      .then(function () {
        if (selectionVersion === state.selectedSignalSelectionVersion &&
            state.selectedSignalLoadingIcao24 === icao24) {
          state.selectedSignalLoadingIcao24 = null;
        }
      });
  }

  function selectedSignalPoints() {
    var cutoff = (state.selectedSignalWindowEnd || Date.now() / 1000) - SIGNAL_ROUTE_WINDOW_SECONDS;
    return mergeSignalPoints(state.selectedSignalHistory, state.selectedSignalProvisional).filter(function (point) {
      return Number(point.timestamp) >= cutoff &&
        finiteNumber(point.aircraft_lon) != null && finiteNumber(point.aircraft_lat) != null;
    });
  }

  function drawableSignalPoint(point) {
    return finiteNumber(point && point.total_loss_db) != null &&
      finiteNumber(point && point.aircraft_lon) != null &&
      finiteNumber(point && point.aircraft_lat) != null &&
      finiteNumber(point && point.aircraft_altitude_m) != null;
  }

  function hasCurrentModeledSignal(flight) {
    var signalV2 = flight && flight.signal_v2;
    var current = signalV2 ? (signalV2.live_current || signalV2.current) : null;
    return drawableSignalPoint(current);
  }

  function drawableSelectedSignalPoints() {
    return selectedSignalPoints().filter(drawableSignalPoint);
  }

  function currentSignalAvailability(flight) {
    var signalV2 = flight && flight.signal_v2;
    var current = signalV2 ? (signalV2.live_current || signalV2.current) : null;
    var candidates = current ? [current] : [];
    if (signalV2 && signalV2.predicted_timeline) {
      candidates = candidates.concat(signalV2.predicted_timeline);
    }
    if (candidates.some(drawableSignalPoint)) {
      return { drawable: true, reason: "Modeled signal available" };
    }
    if (!current) return { drawable: false, reason: "Waiting for modeled signal" };
    if (current.frequency_assignment_status === "outside_40_nm") {
      return { drawable: false, reason: "Outside 40 NM" };
    }
    if (current.frequency_assignment_status === "unavailable") {
      return { drawable: false, reason: "No phase/frequency assignment" };
    }
    return { drawable: false, reason: "Modeled loss unavailable" };
  }

  function activeViewMode() {
    return document.body.getAttribute("data-view-mode") || "plan";
  }

  function signalRouteBounds(points) {
    var bounds = {
      west: Infinity,
      south: Infinity,
      east: -Infinity,
      north: -Infinity
    };
    points.forEach(function (point) {
      var longitude = Number(point.aircraft_lon);
      var latitude = Number(point.aircraft_lat);
      bounds.west = Math.min(bounds.west, longitude);
      bounds.south = Math.min(bounds.south, latitude);
      bounds.east = Math.max(bounds.east, longitude);
      bounds.north = Math.max(bounds.north, latitude);
    });
    return [[bounds.west, bounds.south], [bounds.east, bounds.north]];
  }

  function signalRouteOrbitBounds(points) {
    var bounds = signalRouteBounds(points);
    var west = bounds[0][0];
    var south = bounds[0][1];
    var east = bounds[1][0];
    var north = bounds[1][1];
    var centerLongitude = (west + east) / 2;
    var centerLatitude = (south + north) / 2;
    var longitudeScale = Math.max(0.2, Math.cos(centerLatitude * Math.PI / 180));
    var halfLatitudeSpan = Math.max((north - south) / 2, 0.002);
    var halfLongitudeSpanInLatitudeDegrees = Math.max((east - west) * longitudeScale / 2, 0.002);
    // A square local-metre envelope enlarged by sqrt(2) contains the complete
    // drawable route at every bearing during the 120-degree orbit.
    var halfEnvelope = Math.max(halfLatitudeSpan, halfLongitudeSpanInLatitudeDegrees) * Math.SQRT2;
    var halfLongitudeEnvelope = halfEnvelope / longitudeScale;
    return [
      [centerLongitude - halfLongitudeEnvelope, centerLatitude - halfEnvelope],
      [centerLongitude + halfLongitudeEnvelope, centerLatitude + halfEnvelope]
    ];
  }

  function signalRouteBearing(points) {
    if (points.length < 2) return -20;
    var end = points[points.length - 1];
    var endLongitude = Number(end.aircraft_lon);
    var endLatitude = Number(end.aircraft_lat);
    var start = null;
    for (var index = points.length - 2; index >= 0; index -= 1) {
      if (Number(points[index].aircraft_lon) !== endLongitude ||
          Number(points[index].aircraft_lat) !== endLatitude) {
        start = points[index];
        break;
      }
    }
    if (!start) return finiteNumber(end.heading_deg) == null ? -20 : Number(end.heading_deg);
    var lat1 = Number(start.aircraft_lat) * Math.PI / 180;
    var lat2 = endLatitude * Math.PI / 180;
    var longitudeDelta = (endLongitude - Number(start.aircraft_lon)) * Math.PI / 180;
    var y = Math.sin(longitudeDelta) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(longitudeDelta);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function signalRoutePadding(map) {
    var width = map.getContainer().clientWidth || window.innerWidth;
    if (width >= 1100) return { top: 140, right: 410, bottom: 100, left: 370 };
    return { top: 100, right: 45, bottom: 90, left: 45 };
  }

  function focusSelectedSignalRoute(mode, force) {
    if (mode !== "plan" && mode !== "3d") return false;
    if (!state.selectedIcao24) return false;
    if (mode === "3d" && window.PlatformDisplayMode && window.PlatformDisplayMode.isActive()) return true;
    if (!force && state.selectedSignalFocusedVersions[mode] === state.selectedSignalSelectionVersion) {
      return true;
    }
    var points = drawableSelectedSignalPoints();
    if (points.length < 2) return false;
    var view = mode === "3d" ? window.ThreeDView : window.PlanView;
    var map = view && view.getMap();
    if (!map || !map.isStyleLoaded() || map.getContainer().clientWidth === 0) return false;
    var options = {
      padding: signalRoutePadding(map),
      maxZoom: mode === "3d" ? 15 : 15.5,
      duration: 1100
    };
    if (mode === "3d") {
      options.pitch = 65;
      options.bearing = signalRouteBearing(points);
    }
    map.fitBounds(signalRouteBounds(points), options);
    state.selectedSignalFocusedVersions[mode] = state.selectedSignalSelectionVersion;
    return true;
  }

  function resolveSelectedSignalFocus(selectionVersion) {
    if (selectionVersion !== state.selectedSignalSelectionVersion) return;
    var points = drawableSelectedSignalPoints();
    setSignalLegendVisible(points.length >= 2);
    if (points.length >= 2) {
      focusSelectedSignalRoute(activeViewMode());
      return;
    }
    if (state.selectedSignalNoDataMessageVersion === selectionVersion) return;
    state.selectedSignalNoDataMessageVersion = selectionVersion;
    var flight = state.flights.find(function (item) { return item.icao24 === state.selectedIcao24; });
    var callsign = flight ? (flight.callsign || flight.icao24.toUpperCase()) : "Selected flight";
    var availability = currentSignalAvailability(flight);
    showMessage(callsign + ": no modeled signal is available in the rolling one-hour window (" +
      availability.reason.toLowerCase() + ").");
  }

  function signalStrength(point, signalScale) {
    var loss = finiteNumber(point && point.total_loss_db);
    if (loss == null) return null;
    if (!signalScale || signalScale.referenceLossDb == null) return null;
    return SignalVisualScale.normalize(signalScale.referenceLossDb - loss, signalScale.floorDb);
  }

  function signalFrequencyKey(value) {
    var frequency = finiteNumber(value);
    return frequency == null ? "unknown" : frequency.toFixed(1);
  }

  function signalFrequencyColor(value) {
    return new THREE.Color(
      SIGNAL_FREQUENCY_COLORS[signalFrequencyKey(value)] || SIGNAL_FREQUENCY_UNKNOWN_COLOR
    );
  }

  function disposeSignalObject(object3d) {
    if (!object3d) return;
    var materials = [];
    object3d.traverse(function (node) {
      if (node.geometry && typeof node.geometry.dispose === "function") node.geometry.dispose();
      if (node.material) {
        (Array.isArray(node.material) ? node.material : [node.material]).forEach(function (material) {
          if (materials.indexOf(material) === -1) materials.push(material);
        });
      }
    });
    materials.forEach(function (material) { material.dispose(); });
  }

  function createSelectedSignalLayer(mode) {
    return {
      id: (mode === "3d" ? "three-d-" : "plan-") + "selected-flight-signal-rings",
      type: "custom",
      renderingMode: "3d",
      object3d: null,
      originMercator: null,
      meterScale: 1,
      metrics: { rings: 0, finalizedRings: 0, predictedRings: 0 },
      onAdd: function (map, gl) {
        this.map = map;
        this.camera = new THREE.Camera();
        this.scene = new THREE.Scene();
        this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
        this.renderer.autoClear = false;
        if (this.object3d) this.scene.add(this.object3d);
      },
      setSignalObject: function (payload) {
        if (this.object3d && this.scene) this.scene.remove(this.object3d);
        disposeSignalObject(this.object3d);
        this.object3d = payload ? payload.object3d : null;
        this.metrics = payload ? payload.metrics : { rings: 0, finalizedRings: 0, predictedRings: 0 };
        if (payload) {
          this.originMercator = maplibregl.MercatorCoordinate.fromLngLat(payload.originLonLat, 0);
          this.meterScale = this.originMercator.meterInMercatorCoordinateUnits();
        } else {
          this.originMercator = null;
        }
        if (this.object3d && this.scene) this.scene.add(this.object3d);
        if (this.map) this.map.triggerRepaint();
      },
      render: function (gl, matrix) {
        if (!this.object3d || !this.originMercator) return;
        var projection = new THREE.Matrix4().fromArray(matrix);
        var localTransform = new THREE.Matrix4()
          .makeTranslation(this.originMercator.x, this.originMercator.y, this.originMercator.z)
          .scale(new THREE.Vector3(this.meterScale, this.meterScale, this.meterScale));
        this.camera.projectionMatrix = projection.multiply(localTransform);
        this.renderer.resetState();
        this.renderer.render(this.scene, this.camera);
      }
    };
  }

  function ensureSelectedSignalLayer(map, mode) {
    var property = mode === "3d" ? "threeDSignalLayer" : "planSignalLayer";
    if (!map || state[property]) return;
    var layer = createSelectedSignalLayer(mode);
    state[property] = layer;
    map.addLayer(layer);
    map.on("zoomend", function () { updateSelectedSignalGeometry(mode); });
  }

  function signalMetersPerPixel(map, latitude) {
    return 156543.03392 * Math.cos(latitude * Math.PI / 180) / Math.pow(2, map.getZoom());
  }

  function makeSignalGeometryTarget() {
    return { positions: [], colors: [] };
  }

  function addLineSegment(target, start, end, startColor, endColor) {
    target.positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
    target.colors.push(
      startColor.r, startColor.g, startColor.b,
      endColor.r, endColor.g, endColor.b
    );
  }

  function makeSignalLineObject(target, opacity) {
    if (!target.positions.length) return null;
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(target.positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(target.colors, 3));
    var material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: opacity,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      toneMapped: false
    });
    var lines = new THREE.LineSegments(geometry, material);
    lines.frustumCulled = false;
    return lines;
  }

  function routeTangent(centers, index, previousTangent) {
    var tangent;
    if (index === 0) tangent = centers[1].clone().sub(centers[0]);
    else if (index === centers.length - 1) tangent = centers[index].clone().sub(centers[index - 1]);
    else tangent = centers[index + 1].clone().sub(centers[index - 1]);
    if (tangent.lengthSq() < 1e-8) {
      return previousTangent ? previousTangent.clone() : new THREE.Vector3(1, 0, 0);
    }
    return tangent.normalize();
  }

  function initialRingRight(tangent) {
    var reference = Math.abs(tangent.z) < 0.92
      ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(0, 1, 0);
    var right = new THREE.Vector3().crossVectors(tangent, reference);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    return right.normalize();
  }

  function buildSignalRunGeometry(run, radiusMinM, radiusMaxM, finalizedGeometry, predictedGeometry) {
    var centers = run.map(function (sample) { return sample.center; });
    var previousTangent = null;
    var previousRight = null;
    var previousRing = null;
    var previousColor = null;
    var previousPredicted = false;
    var finalizedRings = 0;
    var predictedRings = 0;

    run.forEach(function (sample, index) {
      var tangent = routeTangent(centers, index, previousTangent);
      var right;
      if (!previousRight || !previousTangent) {
        right = initialRingRight(tangent);
      } else {
        var transport = new THREE.Quaternion().setFromUnitVectors(previousTangent, tangent);
        right = previousRight.clone().applyQuaternion(transport);
        right.addScaledVector(tangent, -right.dot(tangent));
        if (right.lengthSq() < 1e-8) right = initialRingRight(tangent);
        else right.normalize();
      }
      var ringUp = new THREE.Vector3().crossVectors(tangent, right).normalize();
      var visualStrength = Math.pow(sample.strength, SIGNAL_STRENGTH_CONTRAST_EXPONENT);
      var radius = radiusMinM + (radiusMaxM - radiusMinM) * visualStrength;
      var ringColor = signalFrequencyColor(sample.frequency);
      var ring = [];
      for (var angleIndex = 0; angleIndex < SIGNAL_RING_SEGMENTS; angleIndex += 1) {
        var angle = angleIndex / SIGNAL_RING_SEGMENTS * Math.PI * 2;
        ring.push(sample.center.clone()
          .addScaledVector(right, Math.cos(angle) * radius)
          .addScaledVector(ringUp, Math.sin(angle) * radius));
      }

      var ringTarget = sample.predicted ? predictedGeometry : finalizedGeometry;
      for (var ringIndex = 0; ringIndex < SIGNAL_RING_SEGMENTS; ringIndex += 1) {
        addLineSegment(
          ringTarget,
          ring[ringIndex],
          ring[(ringIndex + 1) % SIGNAL_RING_SEGMENTS],
          ringColor,
          ringColor
        );
      }
      if (sample.predicted) predictedRings += 1;
      else finalizedRings += 1;

      if (previousRing) {
        var strandTarget = sample.predicted || previousPredicted ? predictedGeometry : finalizedGeometry;
        for (var strandIndex = 0; strandIndex < SIGNAL_RING_SEGMENTS; strandIndex += 1) {
          addLineSegment(
            strandTarget,
            previousRing[strandIndex],
            ring[strandIndex],
            previousColor,
            ringColor
          );
        }
      }
      previousRing = ring;
      previousColor = ringColor;
      previousPredicted = sample.predicted;
      previousTangent = tangent;
      previousRight = right;
    });
    return { finalizedRings: finalizedRings, predictedRings: predictedRings };
  }

  function makeSelectedSignalObject(map) {
    if (!state.selectedIcao24) return null;
    var points = selectedSignalPoints();
    if (points.length < 2) return null;
    var losses = points.map(function (point) { return finiteNumber(point.total_loss_db); })
      .filter(function (value) { return value != null; });
    var signalScale = SignalVisualScale.fromLosses(losses);
    if (ui.signalScaleLabel) {
      ui.signalScaleLabel.textContent = "MHz · ring size = modeled relative strength (automatic " +
        signalScale.floorDb + " to 0 dB range, cubic contrast); translucent = predicted";
    }
    var originPoint = points[Math.floor(points.length / 2)];
    var originLat = Number(originPoint.aircraft_lat);
    var originLon = Number(originPoint.aircraft_lon);
    var metersPerDegreeLat = 111320;
    var metersPerDegreeLon = metersPerDegreeLat * Math.cos(originLat * Math.PI / 180);
    var metersPerPixel = signalMetersPerPixel(map, originLat);
    var radiusMinM = Math.max(SIGNAL_RING_MIN_RADIUS_M,
      Math.min(80, SIGNAL_RING_MIN_RADIUS_PX * metersPerPixel));
    var radiusMaxM = Math.max(radiusMinM + 1,
      Math.min(SIGNAL_RING_MAX_RADIUS_M, SIGNAL_RING_MAX_RADIUS_PX * metersPerPixel));
    var runs = [];
    var currentRun = [];
    var previousTimestamp = null;

    points.forEach(function (point) {
      var strength = signalStrength(point, signalScale);
      var timestamp = Number(point.timestamp);
      var altitude = finiteNumber(point.aircraft_altitude_m);
      if (strength == null || altitude == null ||
          (previousTimestamp != null && timestamp - previousTimestamp > 5)) {
        if (currentRun.length >= 2) runs.push(currentRun);
        currentRun = [];
      }
      if (strength != null && altitude != null) {
        currentRun.push({
          timestamp: timestamp,
          strength: strength,
          frequency: point.most_likely_frequency_mhz,
          predicted: point.position_status === "predicted",
          center: new THREE.Vector3(
            (Number(point.aircraft_lon) - originLon) * metersPerDegreeLon,
            -(Number(point.aircraft_lat) - originLat) * metersPerDegreeLat,
            Math.max(0, altitude)
          )
        });
      }
      previousTimestamp = timestamp;
    });
    if (currentRun.length >= 2) runs.push(currentRun);
    if (!runs.length) return null;

    var finalizedGeometry = makeSignalGeometryTarget();
    var predictedGeometry = makeSignalGeometryTarget();
    var finalizedRings = 0;
    var predictedRings = 0;
    runs.forEach(function (run) {
      var counts = buildSignalRunGeometry(
        run, radiusMinM, radiusMaxM, finalizedGeometry, predictedGeometry
      );
      finalizedRings += counts.finalizedRings;
      predictedRings += counts.predictedRings;
    });

    var group = new THREE.Group();
    var finalizedObject = makeSignalLineObject(finalizedGeometry, 0.9);
    var predictedObject = makeSignalLineObject(predictedGeometry, 0.38);
    if (finalizedObject) group.add(finalizedObject);
    if (predictedObject) group.add(predictedObject);
    return {
      originLonLat: [originLon, originLat],
      object3d: group,
      metrics: {
        rings: finalizedRings + predictedRings,
        finalizedRings: finalizedRings,
        predictedRings: predictedRings,
        radiusMinM: radiusMinM,
        radiusMaxM: radiusMaxM,
        visualFloorDb: signalScale.floorDb,
        strengthContrastExponent: SIGNAL_STRENGTH_CONTRAST_EXPONENT
      }
    };
  }

  function updateSelectedSignalGeometry(mode) {
    [
      { mode: "plan", map: window.PlanView && window.PlanView.getMap(), layer: state.planSignalLayer },
      { mode: "3d", map: window.ThreeDView && window.ThreeDView.getMap(), layer: state.threeDSignalLayer }
    ].forEach(function (target) {
      if (mode && target.mode !== mode) return;
      if (!target.map || !target.layer) return;
      target.layer.setSignalObject(makeSelectedSignalObject(target.map));
    });
  }

  function detailRow(key, value) {
    var row = document.createElement("tr");
    var header = document.createElement("th");
    var cell = document.createElement("td");
    header.scope = "row";
    header.textContent = key;
    cell.textContent = value;
    row.append(header, cell);
    return row;
  }

  function bindFilter(group, property) {
    group.addEventListener("click", function (event) {
      var button = event.target.closest("button[data-value]");
      if (!button) return;
      state[property] = button.getAttribute("data-value");
      Array.prototype.forEach.call(group.querySelectorAll("button[data-value]"), function (option) {
        option.classList.toggle("selected", option === button);
      });
      renderFlightButtons();
      updateFlightLayers();
    });
  }

  function statusVisibilityKey(value) {
    return value === "no-current" ? "noCurrent" : value;
  }

  function allStatusesVisible() {
    return state.statusVisibility.confirmed &&
      state.statusVisibility.probable &&
      state.statusVisibility.noCurrent;
  }

  function syncStatusFilterButtons() {
    var allVisible = allStatusesVisible();
    Array.prototype.forEach.call(ui.statusFilter.querySelectorAll("button[data-value]"), function (option) {
      var value = option.getAttribute("data-value");
      var selected = value === "all"
        ? allVisible
        : state.statusVisibility[statusVisibilityKey(value)] === true;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
  }

  function selectedFlightPassesFilters() {
    if (!state.selectedIcao24) return true;
    return filteredFlights().some(function (flight) {
      return flight.icao24 === state.selectedIcao24;
    });
  }

  function bindStatusFilter() {
    ui.statusFilter.addEventListener("click", function (event) {
      var button = event.target.closest("button[data-value]");
      if (!button) return;
      var value = button.getAttribute("data-value");
      if (value === "all") {
        state.statusVisibility.confirmed = true;
        state.statusVisibility.probable = true;
        state.statusVisibility.noCurrent = true;
      } else {
        var key = statusVisibilityKey(value);
        state.statusVisibility[key] = !state.statusVisibility[key];
      }
      syncStatusFilterButtons();
      if (!selectedFlightPassesFilters()) {
        closeDetails();
        return;
      }
      renderFlightButtons();
      updateFlightLayers();
    });
  }

  function circleFeature(longitude, latitude, radiusNm, steps) {
    var coordinates = [];
    var angularDistance = radiusNm / 3440.065;
    var lat1 = latitude * Math.PI / 180;
    var lon1 = longitude * Math.PI / 180;
    for (var index = 0; index <= steps; index += 1) {
      var bearing = 2 * Math.PI * index / steps;
      var lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(angularDistance) +
        Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
      );
      var lon2 = lon1 + Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
        Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
      );
      coordinates.push([lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]);
    }
    return {
      type: "Feature",
      properties: { radius_nm: radiusNm },
      geometry: { type: "Polygon", coordinates: [coordinates] }
    };
  }

  function formatNumber(value, digits, suffix) {
    if (value == null || !Number.isFinite(Number(value))) return "--";
    return Number(value).toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }) + (suffix || "");
  }
  function formatSigned(value, digits, suffix) {
    if (value == null || !Number.isFinite(Number(value))) return "--";
    var number = Number(value);
    return (number > 0 ? "+" : "") + formatNumber(number, digits, suffix);
  }
  function formatClock(epochMilliseconds) {
    if (!epochMilliseconds) return "--";
    return new Date(epochMilliseconds).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  }
  function formatDateTime(epochSeconds) {
    return epochSeconds ? new Date(epochSeconds * 1000).toLocaleString() : "--";
  }
  function capitalize(value) {
    if (!value) return "Unknown";
    return String(value).charAt(0).toUpperCase() + String(value).slice(1);
  }
  function label(value) {
    if (!value) return "Unknown";
    return String(value).split("_").map(capitalize).join(" ");
  }
  function showMessage(message) {
    ui.mapMessage.textContent = message;
    ui.mapMessage.classList.add("visible");
    window.clearTimeout(state.messageTimer);
    state.messageTimer = window.setTimeout(function () {
      ui.mapMessage.classList.remove("visible");
    }, 8000);
  }

  document.addEventListener("platform:plan-map-ready", function () {
    attachOverlay(window.PlanView && window.PlanView.getMap(), "plan");
    window.setTimeout(function () { focusSelectedSignalRoute("plan"); }, 0);
  });
  document.addEventListener("platform:three-d-map-ready", function () {
    attachOverlay(window.ThreeDView && window.ThreeDView.getMap(), "3d");
    window.setTimeout(function () { focusSelectedSignalRoute("3d"); }, 0);
  });
  document.addEventListener("platform:view-changed", function (event) {
    var mode = event.detail && event.detail.mode;
    if (mode !== "plan" && mode !== "3d") return;
    window.setTimeout(function () {
      updateSelectedSignalGeometry(mode);
      focusSelectedSignalRoute(mode);
    }, 0);
  });
  document.addEventListener("platform:three-d-subway-routes-updated", function (event) {
    state.subwayRoutes3D = (event.detail && event.detail.featureCollection) || null;
    updateFlightLayers();
  });
  document.addEventListener("platform:subway-route-focused", function (event) {
    var routeId = (event.detail && event.detail.route) || null;
    state.activeSubwayRouteId = routeId;
    // Focusing a subway line takes Section View over from any selected plane, so drop that
    // selection outright -- closing its details panel and clearing its pill highlight, the
    // same way selecting a plane releases a focused line. No loop: closeDetails calls
    // setActiveSectionFlight(null), and index.html only releases the focused line when a
    // flight is actually being selected.
    if (routeId && state.selectedIcao24) closeDetails();
    updateFlightLayers();
  });
  document.addEventListener("platform:subway-stations-updated", function (event) {
    var detail = event.detail || {};
    state.subwayStations3D = detail.featureCollection || null;
    state.subwayStationsColor = detail.color || null;
    updateFlightLayers();
  });
  document.addEventListener("platform:train-selected", function (event) {
    if (state.selectedIcao24) closeDetails();
    state.selectedTrainRouteId = (event.detail && event.detail.route) || null;
    updateFlightLayers();
  });
  document.addEventListener("platform:train-deselected", function () {
    state.selectedTrainRouteId = null;
    updateFlightLayers();
  });
  document.addEventListener("platform:subways-updated", function (event) {
    var detail = event.detail || {};
    ui.subwayCount.textContent = detail.count == null ? "0" : String(detail.count);
    ui.subwayLines.textContent = detail.visibleRoutes && detail.visibleRoutes.length
      ? detail.visibleRoutes.join(" + ")
      : "None";
    ui.subwayUpdate.textContent = detail.updatedAt ? formatClock(detail.updatedAt) : "--";
  });

  bindStatusFilter();
  bindFilter(ui.directionFilter, "directionFilter");
  ui.detailsClose.addEventListener("click", closeDetails);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeDetails();
  });

  var existingPlanMap = window.PlanView && window.PlanView.getMap();
  if (existingPlanMap && existingPlanMap.isStyleLoaded()) attachOverlay(existingPlanMap, "plan");

  // Narrow bridge for fullscreen Display Mode. Manual flight buttons and map
  // picking continue to use selectFlight directly and remain unchanged.
  window.PlatformFlightDisplay = {
    getCandidates: function () {
      return filteredFlights().filter(function (flight) {
        if (!flight.active || !flight.current || currentSignalAvailability(flight).drawable !== true) return false;
        var signalV2 = flight.signal_v2 || {};
        var signalPoints = [];
        if (signalV2.live_current || signalV2.current) signalPoints.push(signalV2.live_current || signalV2.current);
        signalPoints = signalPoints.concat(signalV2.predicted_timeline || []);
        return signalPoints.filter(drawableSignalPoint).length >= 2 &&
          finiteNumber(flight.current.longitude) != null && finiteNumber(flight.current.latitude) != null;
      }).map(function (flight) {
        return {
          kind: "flight",
          id: flight.icao24,
          key: "flight:" + flight.icao24,
          label: flight.callsign || flight.icao24.toUpperCase()
        };
      });
    },
    select: function (icao24) {
      if (!state.flights.some(function (flight) { return flight.icao24 === icao24; })) return false;
      selectFlight(icao24);
      return true;
    },
    getCameraTarget: function (icao24, map) {
      if (String(state.selectedIcao24 || "").toLowerCase() !== String(icao24 || "").toLowerCase()) return null;
      var points = drawableSelectedSignalPoints();
      if (points.length < 2 || !map) return null;
      var padding = signalRoutePadding(map);
      var orbitMargin = 60;
      return {
        kind: "bounds",
        bounds: signalRouteOrbitBounds(points),
        bearing: signalRouteBearing(points),
        padding: {
          top: padding.top + orbitMargin,
          right: padding.right + orbitMargin,
          bottom: padding.bottom + orbitMargin,
          left: padding.left + orbitMargin
        },
        maxZoom: 14.5,
        ready: state.selectedSignalLoadingIcao24 !== String(icao24 || "").toLowerCase()
      };
    },
    getPose: function (icao24) {
      var flight = state.flights.find(function (item) { return item.icao24 === icao24; });
      if (!flight || !flight.current) return null;
      var live = flight.signal_v2 && flight.signal_v2.live_current;
      if (live && finiteNumber(live.aircraft_lon) != null && finiteNumber(live.aircraft_lat) != null) {
        return {
          center: [Number(live.aircraft_lon), Number(live.aircraft_lat)],
          heading: finiteNumber(live.heading_deg) == null ? Number(flight.current.heading_deg) || 0 : Number(live.heading_deg)
        };
      }
      if (finiteNumber(flight.current.longitude) == null || finiteNumber(flight.current.latitude) == null) return null;
      return {
        center: [Number(flight.current.longitude), Number(flight.current.latitude)],
        heading: Number(flight.current.heading_deg) || 0
      };
    }
  };

  fetchBatch();
  // New batches only land roughly every 25-30 minutes now, so there's no need
  // to poll for one as aggressively as the old 5-minute-cadence design did.
  window.setInterval(fetchBatch, 150000);
  // Recompute which already-fetched snapshot corresponds to "30 minutes ago"
  // every 30s -- the display advances with the wall clock, not this timer,
  // so a throttled/backgrounded tab just catches up on its next tick instead
  // of drifting.
  window.setInterval(applyCurrentSnapshot, 30000);
  window.setInterval(advanceSignalClock, 1000);
})();
