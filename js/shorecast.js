/**
 * Shorecast — shore diving / entry conditions using Open-Meteo (marine + weather).
 * No API keys; runs in the browser. Not medical or dive-training advice.
 */

const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const NOAA_DATAGETTER = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

/** South Florida — fixed pins (not GPS). NOAA ids are nearby CO-OPS stations for tide links. */
const PRESETS_SOUTH_FL = [
  { name: "Lauderdale-by-the-Sea, Florida", short: "Lauderdale-by-the-Sea", lat: 26.1923, lon: -80.0964, tz: "America/New_York", noaaId: "8722956" },
  { name: "Miami Beach, Florida", short: "Miami Beach", lat: 25.7907, lon: -80.1300, tz: "America/New_York", noaaId: "8723170" },
  { name: "Key Largo, Florida", short: "Key Largo", lat: 25.0865, lon: -80.4473, tz: "America/New_York", noaaId: "8723214" },
  { name: "Islamorada, Florida", short: "Islamorada", lat: 24.9243, lon: -80.6284, tz: "America/New_York", noaaId: "8723970" },
  { name: "Pompano Beach, Florida", short: "Pompano Beach", lat: 26.2278, lon: -80.0928, tz: "America/New_York", noaaId: "8722956" },
  { name: "Deerfield Beach, Florida", short: "Deerfield Beach", lat: 26.3184, lon: -80.0659, tz: "America/New_York", noaaId: "8722956" },
  { name: "Boca Raton, Florida", short: "Boca Raton", lat: 26.3683, lon: -80.1289, tz: "America/New_York", noaaId: "8722670" },
  { name: "West Palm Beach, Florida", short: "West Palm Beach", lat: 26.7153, lon: -80.0534, tz: "America/New_York", noaaId: "8722670" },
  { name: "Jupiter, Florida", short: "Jupiter", lat: 26.9342, lon: -80.0942, tz: "America/New_York", noaaId: "8722669" },
];

const PRESETS_OTHER = [
  { name: "San Diego (La Jolla), California", short: "La Jolla", lat: 32.8328, lon: -117.2713, tz: "America/Los_Angeles", noaaId: "9410230" },
  { name: "Kailua-Kona, Hawaii", short: "Kona", lat: 19.639, lon: -155.9969, tz: "Pacific/Honolulu", noaaId: "1615680" },
];

/** Rough IANA zone for Open-Meteo `timezone` (hourly labels bucket correctly). */
function guessTimezone(lat, lon) {
  if (lat >= 18 && lat <= 23 && lon <= -154 && lon >= -162) return "Pacific/Honolulu";
  if (lon < -115 && lat > 28 && lat < 52) return "America/Los_Angeles";
  if (lon < -102 && lat > 24 && lat < 37) return "America/Phoenix";
  if (lon < -95) return "America/Chicago";
  return "America/New_York";
}

/** Calendar date for "now" in a given IANA zone (matches Open-Meteo `timezone`). */
function todayKeyForTz(iana) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: iana,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Open-Meteo hourly `time` is local wall time without `Z`; avoid `Date` parsing for bucketing. */
function dateKeyFromApiLocal(iso) {
  return iso.slice(0, 10);
}

function hourFromApiLocal(iso) {
  const t = iso.split("T")[1];
  if (!t) return 12;
  return parseInt(t.slice(0, 2), 10) || 0;
}

/** Factor weights (sum = 1). Tunable heuristic model. */
const WEIGHTS = {
  wind: 0.14,
  swellH: 0.14,
  swellP: 0.12,
  waveH: 0.08,
  windWave: 0.06,
  airVis: 0.08,
  waterProxy: 0.2,
  airTemp: 0.09,
  seaTemp: 0.09,
};

const M_TO_FT = 3.28084;
const M_TO_MI = 1 / 1609.344;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function degToCompass(deg) {
  if (deg == null || Number.isNaN(deg)) return "—";
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return dirs[i];
}

function cToF(c) {
  if (c == null) return null;
  return (c * 9) / 5 + 32;
}

function scoreWindKn(kn) {
  if (kn == null) return 70;
  if (kn <= 8) return 100;
  if (kn <= 12) return 90 - (kn - 8) * 2.5;
  if (kn <= 16) return 80 - (kn - 12) * 4;
  if (kn <= 22) return 64 - (kn - 16) * 3;
  return clamp(40 - (kn - 22) * 2, 15, 40);
}

function scoreSwellFt(ft) {
  if (ft == null) return 75;
  if (ft <= 0.5) return 100;
  if (ft <= 1) return 95 - (ft - 0.5) * 10;
  if (ft <= 2) return 90 - (ft - 1) * 12;
  if (ft <= 3.5) return 78 - (ft - 2) * 10;
  return clamp(62 - (ft - 3.5) * 12, 10, 62);
}

function scorePeriod(sec) {
  if (sec == null) return 65;
  if (sec >= 14) return 100;
  if (sec >= 12) return 95;
  if (sec >= 10) return 88;
  if (sec >= 8) return 75;
  if (sec >= 6) return 58;
  return clamp(45 - (6 - sec) * 5, 20, 45);
}

function scoreWaveM(m) {
  const ft = (m ?? 0) * M_TO_FT;
  if (ft <= 0.8) return 100;
  if (ft <= 1.5) return 88 - (ft - 0.8) * 8;
  if (ft <= 2.5) return 82 - (ft - 1.5) * 12;
  return clamp(70 - (ft - 2.5) * 15, 15, 70);
}

function scoreVisMi(mi) {
  if (mi == null) return 70;
  if (mi >= 10) return 100;
  if (mi >= 6) return 85 + (mi - 6) * (15 / 4);
  if (mi >= 3) return 60 + (mi - 3) * (25 / 3);
  return clamp(35 + mi * 8, 15, 60);
}

function scoreTempComfortF(f) {
  if (f == null) return 80;
  if (f >= 74 && f <= 90) return 100;
  if (f >= 68 && f < 74) return 88 + (f - 68) * 2;
  if (f > 90 && f <= 96) return 100 - (f - 90) * 5;
  if (f >= 60 && f < 68) return 72 + (f - 60) * 2;
  return clamp(55, 40, 75);
}

function labelForScore(s) {
  if (s >= 90) return "Excellent";
  if (s >= 78) return "Great";
  if (s >= 65) return "Good";
  if (s >= 50) return "Fair";
  return "Poor";
}

function ratingClass(s) {
  if (s >= 78) return "";
  if (s >= 50) return "fair";
  return "poor";
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Windy embed: waves overlay at the same coordinates as the forecast pin. */
function buildWindyEmbedUrl(lat, lon) {
  const z = Math.abs(lat) > 50 ? 9 : 11;
  const p = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    zoom: String(z),
    level: "surface",
    overlay: "waves",
    menu: "",
    message: "false",
    marker: "true",
    calendar: "now",
    pressure: "",
    type: "map",
    location: "coordinates",
    detail: "",
    detailLat: String(lat),
    detailLon: String(lon),
  });
  return `https://embed.windy.com/embed2.html?${p}`;
}

/**
 * NOAA returns wall time as "YYYY-MM-DD HH:mm" in station `lst_ldt`.
 * Format for display without re-zoning (avoids browser-local misreads).
 */
function formatNoaaClock(tStr) {
  const m = String(tStr).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) return tStr;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  let hh = Number(m[4]);
  const mi = Number(m[5]);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mo - 1];
  const ap = hh >= 12 ? "pm" : "am";
  const h12 = hh % 12 || 12;
  const mm = String(mi).padStart(2, "0");
  return `${mon} ${d} · ${h12}:${mm}${ap}`;
}

async function fetchNoaaHiloPredictions(stationId, stationTz) {
  const begin = todayKeyForTz(stationTz).replace(/-/g, "");
  const q = new URLSearchParams({
    begin_date: begin,
    range: "168",
    station: String(stationId),
    product: "predictions",
    datum: "MLLW",
    interval: "hilo",
    units: "english",
    time_zone: "lst_ldt",
    format: "json",
    application: "Shorecast",
  });
  const data = await fetchJson(`${NOAA_DATAGETTER}?${q}`);
  if (data.error) throw new Error(data.error.message || "NOAA tide error");
  const preds = data.predictions;
  if (!Array.isArray(preds) || !preds.length) throw new Error("No tide predictions returned.");
  return preds;
}

function buildMarineParams(lat, lon, tz) {
  const h = [
    "swell_wave_height",
    "swell_wave_period",
    "swell_wave_direction",
    "wind_wave_height",
    "wave_height",
    "sea_surface_temperature",
  ].join(",");
  const p = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: h,
    forecast_days: "10",
    past_days: "2",
    timezone: tz,
  });
  return `${MARINE_URL}?${p}`;
}

function buildWeatherParams(lat, lon, tz) {
  const h = [
    "temperature_2m",
    "visibility",
    "precipitation",
    "rain",
    "wind_speed_10m",
    "wind_direction_10m",
  ].join(",");
  const p = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: h,
    forecast_days: "10",
    past_days: "2",
    timezone: tz,
    wind_speed_unit: "kn",
  });
  return `${WEATHER_URL}?${p}`;
}

/**
 * Merge marine + weather hourly rows by ISO time string.
 */
function mergeSeries(marine, weather) {
  const mt = marine.hourly?.time ?? [];
  const wt = weather.hourly?.time ?? [];
  const mapW = new Map();
  for (let i = 0; i < wt.length; i++) {
    mapW.set(wt[i], i);
  }
  const rows = [];
  for (let i = 0; i < mt.length; i++) {
    const t = mt[i];
    const wi = mapW.get(t);
    if (wi == null) continue;
    rows.push({
      time: t,
      swell_m: marine.hourly.swell_wave_height?.[i] ?? null,
      swell_s: marine.hourly.swell_wave_period?.[i] ?? null,
      swell_dir: marine.hourly.swell_wave_direction?.[i] ?? null,
      wind_wave_m: marine.hourly.wind_wave_height?.[i] ?? null,
      wave_m: marine.hourly.wave_height?.[i] ?? null,
      sst_c: marine.hourly.sea_surface_temperature?.[i] ?? null,
      temp_c: weather.hourly.temperature_2m?.[wi] ?? null,
      vis_m: weather.hourly.visibility?.[wi] ?? null,
      precip_mm: weather.hourly.precipitation?.[wi] ?? weather.hourly.rain?.[wi] ?? 0,
      wind_kn: weather.hourly.wind_speed_10m?.[wi] ?? null,
      wind_dir: weather.hourly.wind_direction_10m?.[wi] ?? null,
    });
  }
  return rows;
}

/** Many null marine heights → grid point is weak for swell/surf zone (e.g. inland). */
function assessLowMarineConfidence(rows) {
  if (!rows.length) return true;
  const sample = rows.slice(0, Math.min(rows.length, 144));
  let thin = 0;
  for (const r of sample) {
    if (r.swell_m == null && r.wave_m == null) thin++;
  }
  return thin / sample.length > 0.5;
}

function isEntryWindow(iso) {
  const h = hourFromApiLocal(iso);
  return h >= 7 && h <= 18;
}

function aggregateDay(rows, key) {
  const dayRows = rows.filter((r) => dateKeyFromApiLocal(r.time) === key && isEntryWindow(r.time));
  if (!dayRows.length) {
    const fallback = rows.filter((r) => dateKeyFromApiLocal(r.time) === key);
    if (!fallback.length) return null;
    return aggregateStats(fallback);
  }
  return aggregateStats(dayRows);
}

function aggregateStats(dayRows) {
  const nums = (sel) => dayRows.map(sel).filter((v) => v != null && !Number.isNaN(v));
  const maxOf = (sel) => {
    const a = nums(sel);
    return a.length ? Math.max(...a) : null;
  };
  const minOf = (sel) => {
    const a = nums(sel);
    return a.length ? Math.min(...a) : null;
  };
  const avgOf = (sel) => {
    const a = nums(sel);
    if (!a.length) return null;
    return a.reduce((s, v) => s + v, 0) / a.length;
  };

  return {
    windMaxKn: maxOf((r) => r.wind_kn),
    swellMaxFt: maxOf((r) => (r.swell_m ?? 0) * M_TO_FT),
    swellMinS: minOf((r) => r.swell_s),
    waveMaxM: maxOf((r) => r.wave_m),
    windWaveMaxFt: maxOf((r) => (r.wind_wave_m ?? 0) * M_TO_FT),
    visMinMi: minOf((r) => (r.vis_m ?? 0) * M_TO_MI),
    airTempAvgF: avgOf((r) => cToF(r.temp_c)),
    sstAvgF: avgOf((r) => cToF(r.sst_c)),
    /** Representative hour for wind direction (hour of max wind). */
    windDirAtMax: (() => {
      let max = -1;
      let dir = null;
      for (const r of dayRows) {
        const w = r.wind_kn ?? 0;
        if (w > max) {
          max = w;
          dir = r.wind_dir;
        }
      }
      return dir;
    })(),
    swellDirSample: dayRows.find((r) => r.swell_dir != null)?.swell_dir ?? null,
  };
}

/** Rain + swell heuristic for calendar days up to and including `dayKey` (string YYYY-MM-DD). */
function waterProxyScoreForDay(rows, dayKey) {
  const sortedKeys = [...new Set(rows.map((r) => dateKeyFromApiLocal(r.time)))].sort();
  const i = sortedKeys.indexOf(dayKey);
  const fromIdx = Math.max(0, i - 2);
  const windowKeys = new Set(sortedKeys.slice(fromIdx, i + 1));
  let rainMm = 0;
  let maxS = 0;
  for (const r of rows) {
    const k = dateKeyFromApiLocal(r.time);
    if (!windowKeys.has(k)) continue;
    rainMm += Math.max(0, r.precip_mm ?? 0);
    maxS = Math.max(maxS, (r.swell_m ?? 0) * M_TO_FT);
  }
  const rainIn = rainMm / 25.4;
  let score = 100;
  score -= clamp(rainIn * 22, 0, 48);
  score -= clamp(Math.max(0, maxS - 0.8) * 14, 0, 38);
  return { score: clamp(score, 0, 100), rain48in: rainIn, maxSwell48ft: maxS };
}

function breakdownForDay(stats, rows, dayKey) {
  const wp = waterProxyScoreForDay(rows, dayKey);

  const wWind = scoreWindKn(stats.windMaxKn);
  const wSwellH = scoreSwellFt(stats.swellMaxFt);
  const wSwellP = scorePeriod(stats.swellMinS);
  const wWave = scoreWaveM(stats.waveMaxM);
  const wWw = scoreSwellFt(stats.windWaveMaxFt);
  const wVis = scoreVisMi(stats.visMinMi);
  const wAir = scoreTempComfortF(stats.airTempAvgF);
  const wSea = scoreTempComfortF(stats.sstAvgF);

  const total =
    wWind * WEIGHTS.wind +
    wSwellH * WEIGHTS.swellH +
    wSwellP * WEIGHTS.swellP +
    wWave * WEIGHTS.waveH +
    wWw * WEIGHTS.windWave +
    wVis * WEIGHTS.airVis +
    wp.score * WEIGHTS.waterProxy +
    wAir * WEIGHTS.airTemp +
    wSea * WEIGHTS.seaTemp;

  const windKn = stats.windMaxKn ?? 0;
  const swellFt = stats.swellMaxFt ?? 0;
  const swellS = stats.swellMinS ?? 0;
  const wavePowerApprox = (stats.waveMaxM ?? 0) * (stats.waveMaxM ?? 0) / Math.max(swellS, 1);

  return {
    overall: Math.round(clamp(total, 0, 100)),
    wp,
    factors: [
      {
        id: "wind",
        name: "Wind Speed",
        value: `${windKn.toFixed(0)} kn ${degToCompass(stats.windDirAtMax)}`,
        score: Math.round(wWind),
        weightPct: Math.round(WEIGHTS.wind * 100),
        note: windKn <= 10 ? "Calm = easier shore entry." : "Stronger wind — more surface chop.",
        warn: windKn > 15,
        why: "Uses the max wind speed between 7am–6pm (model local time). Scoring: about 100 at ≤8 kn, easing through 8–12 kn, steeper drop 12–22 kn, very low above ~22 kn. Values above ~15 kn are flagged as caution for the surf zone.",
      },
      {
        id: "swell",
        name: "Swell Size",
        value: `${swellFt.toFixed(1)} ft`,
        score: Math.round(wSwellH),
        weightPct: Math.round(WEIGHTS.swellH * 100),
        note: swellFt <= 1.5 ? "Small swell = gentler surf zone." : "Larger swell — use caution at entry.",
        warn: swellFt > 2,
        why: "Uses the maximum swell height (ft) in that daytime window. Tiny swell scores near 100; scores fall as swell grows, with stronger penalties past ~1.5–2 ft for shore entries.",
      },
      {
        id: "period",
        name: "Swell Period",
        value: `${swellS.toFixed(1)} s`,
        score: Math.round(wSwellP),
        weightPct: Math.round(WEIGHTS.swellP * 100),
        note: swellS >= 10 ? "Longer period = cleaner sets." : "Short period can mean confused chop.",
        warn: swellS < 8,
        why: "Uses the shortest swell period in the window (chop proxy). Longer periods (about 10–14+ s) score higher; under ~8 s is flagged because energy arrives in shorter, messier intervals.",
      },
      {
        id: "power",
        name: "Wave energy (proxy)",
        value: `${wavePowerApprox.toFixed(2)}`,
        score: Math.round(wWave),
        weightPct: Math.round(WEIGHTS.waveH * 100),
        note: "From combined sea height (Open-Meteo). Lower is calmer at the surface.",
        warn: wWave < 70,
        why: "Based on the max combined significant wave height (marine wave_height) in meters, converted to feet mentally for the bar. Larger combined seas lower the score; this is not the same as swell-only height.",
      },
      {
        id: "ww",
        name: "Wind waves",
        value: `${(stats.windWaveMaxFt ?? 0).toFixed(1)} ft`,
        score: Math.round(wWw),
        weightPct: Math.round(WEIGHTS.windWave * 100),
        note: (stats.windWaveMaxFt ?? 0) < 0.5 ? "Mostly glassy wind sea." : "Wind-driven chop possible.",
        warn: (stats.windWaveMaxFt ?? 0) > 1,
        why: "Max wind-sea height in the window. Low wind waves score high; above ~1 ft the score drops and the flag warns of wind-driven chop on top of any swell.",
      },
      {
        id: "vis",
        name: "Air visibility",
        value: `${(stats.visMinMi ?? 0).toFixed(1)} mi`,
        score: Math.round(wVis),
        weightPct: Math.round(WEIGHTS.airVis * 100),
        note: "Miles of view above the water (meteorological visibility).",
        warn: wVis < 75,
        why: "Uses the minimum air visibility (miles) in the daytime window. 10+ mi is best; under ~6 mi the score falls quickly. This is not underwater visibility.",
      },
      {
        id: "water",
        name: "Water clarity (heuristic)",
        value: `${wp.rain48in.toFixed(2)} in rain / 48h`,
        score: Math.round(wp.score),
        weightPct: Math.round(WEIGHTS.waterProxy * 100),
        note: "Proxy from recent rain + swell — not satellite turbidity. Expect reduced vis after runoff.",
        warn: wp.score < 72,
        why: "Heuristic from cumulative hourly precip and max swell over recent calendar days vs. your selected day — not Kd or satellite turbidity. Heavy rain or swell runoff lowers this sub-score to hint at murkier water.",
      },
      {
        id: "airt",
        name: "Air temperature",
        value: `${(stats.airTempAvgF ?? 0).toFixed(0)}°F`,
        score: Math.round(wAir),
        weightPct: Math.round(WEIGHTS.airTemp * 100),
        note: "Comfort for surface interval / suit choice.",
        warn: false,
        why: "Daytime average air temp. A comfort band around the mid-70s to low-90s °F scores near 100; cooler or hotter hours reduce the score modestly.",
      },
      {
        id: "sea",
        name: "Sea surface temp",
        value: `${(stats.sstAvgF ?? 0).toFixed(0)}°F`,
        score: Math.round(wSea),
        weightPct: Math.round(WEIGHTS.seaTemp * 100),
        note: stats.sstAvgF != null ? "SST from marine model." : "SST missing at this grid point.",
        warn: false,
        why: "Daytime average sea-surface temperature from the marine model, same comfort curve as air. If SST is missing at this grid point, the neutral fallback can hide data gaps — check the confidence banner.",
      },
    ],
  };
}

function longDateLabel(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatDayLabel(isoDateKey, todayKey, idx) {
  const [y, m, d] = isoDateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  if (isoDateKey === todayKey) return `Today ${mon} ${d}`;
  return `${wd} ${mon} ${d}`;
}

function init() {
  const el = {
    root: document.getElementById("shorecast-root"),
    locBtn: document.getElementById("loc-btn"),
    locLabel: document.getElementById("loc-label"),
    locPanel: document.getElementById("loc-panel"),
    locSearch: document.getElementById("loc-search"),
    presetListSf: document.getElementById("preset-list-sf"),
    presetListOther: document.getElementById("preset-list-other"),
    dayGrid: document.getElementById("day-grid"),
    main: document.getElementById("main-content"),
    status: document.getElementById("status"),
    donutFg: document.querySelector(".donut-fg"),
    donutNum: document.getElementById("donut-num"),
    detailLoc: document.getElementById("detail-loc"),
    pillStatus: document.getElementById("pill-status"),
    statWind: document.getElementById("stat-wind"),
    statSwell: document.getElementById("stat-swell"),
    statTemp: document.getElementById("stat-temp"),
    statVis: document.getElementById("stat-vis"),
    breakdown: document.getElementById("breakdown"),
    chartSwell: document.getElementById("chart-swell"),
    chartRain: document.getElementById("chart-rain"),
    alert48: document.getElementById("alert-48"),
    hourlyTitle: document.getElementById("hourly-title"),
    hourStrip: document.getElementById("hour-strip"),
    btnRefresh: document.getElementById("nav-refresh"),
    tideLine: document.getElementById("tide-line"),
    dataFresh: document.getElementById("data-fresh"),
    confidenceBanner: document.getElementById("confidence-banner"),
    btnUseGeo: document.getElementById("btn-use-geo"),
    windyFrame: document.getElementById("windy-embed"),
    tidePanel: document.getElementById("tide-panel"),
  };

  let tz = PRESETS_SOUTH_FL[0].tz;
  let lat = PRESETS_SOUTH_FL[0].lat;
  let lon = PRESETS_SOUTH_FL[0].lon;
  let placeName = PRESETS_SOUTH_FL[0].name;
  let placeShort = PRESETS_SOUTH_FL[0].short;
  /** NOAA CO-OPS station id for tide link; null when location is custom / geolocated. */
  let currentNoaaId = PRESETS_SOUTH_FL[0].noaaId ?? null;
  let merged = [];
  let dayKeys = [];
  let selectedKey = null;
  let searchTimer = null;

  function renderTideLine() {
    if (!el.tideLine) return;
    const mapUrl = "https://tidesandcurrents.noaa.gov/map/";
    const curUrl = "https://tidesandcurrents.noaa.gov/currents/";
    const tideLink = currentNoaaId
      ? `<a href="https://tidesandcurrents.noaa.gov/noaatidepredictions.html?id=${encodeURIComponent(currentNoaaId)}" target="_blank" rel="noopener">NOAA official tide page (this preset station)</a>`
      : `<a href="${mapUrl}" target="_blank" rel="noopener">NOAA tides map</a> — pick a U.S. station near this spot`;
    el.tideLine.innerHTML = `${tideLink}. <strong>Tide stage and currents</strong> matter for entries; high/low below is from NOAA predictions (saved spots only). Swell on the water is on the <a href="#windy-map">Windy map</a>. For currents see <a href="${curUrl}" target="_blank" rel="noopener">NOAA currents</a>.`;
  }

  function updateWindyEmbed() {
    if (!el.windyFrame) return;
    el.windyFrame.src = buildWindyEmbedUrl(lat, lon);
  }

  function renderTidePanelMessage(html) {
    if (!el.tidePanel) return;
    el.tidePanel.innerHTML = html;
  }

  function renderTidePanelFromPredictions(preds, stationId) {
    if (!el.tidePanel || !preds?.length) return;
    const byDay = new Map();
    for (const row of preds) {
      const dayKey = String(row.t).slice(0, 10);
      if (!byDay.has(dayKey)) byDay.set(dayKey, []);
      byDay.get(dayKey).push(row);
    }
    const blocks = [];
    for (const [dayKey, rows] of byDay) {
      const [y, mo, d] = dayKey.split("-").map(Number);
      const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(y, mo - 1, d).getDay()];
      const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mo - 1];
      const lines = rows
        .map((r) => {
          const typ = r.type === "H" ? "High" : r.type === "L" ? "Low" : "—";
          const ft = Number.parseFloat(r.v);
          const v = Number.isFinite(ft) ? `${ft.toFixed(1)} ft` : escapeHtml(String(r.v));
          return `<div class="tide-row"><span class="tide-type ${r.type === "H" ? "hi" : "lo"}">${typ}</span><span class="tide-when">${escapeHtml(formatNoaaClock(r.t))}</span><span class="tide-val">${v}</span></div>`;
        })
        .join("");
      blocks.push(`<div class="tide-day"><div class="tide-day-h">${escapeHtml(wd)} ${escapeHtml(mon)} ${d}</div>${lines}</div>`);
    }
    const noaa = `https://tidesandcurrents.noaa.gov/noaatidepredictions.html?id=${encodeURIComponent(stationId)}`;
    el.tidePanel.innerHTML = `
      <p class="tide-panel-note">Heights are MLLW feet at NOAA station <strong>${escapeHtml(String(stationId))}</strong> (near this preset). <a href="${noaa}" target="_blank" rel="noopener">Full NOAA table</a></p>
      <div class="tide-days">${blocks.join("")}</div>
    `;
  }

  function renderTidePanelNoStation() {
    renderTidePanelMessage(
      `<p class="tide-panel-note">In-app high/low tides use a NOAA station tied to each <strong>saved spot</strong>. For search or GPS, use the NOAA map link above or the official station page after you pick a gauge.</p>`
    );
  }

  function renderTidePanelError(msg) {
    const mapUrl = "https://tidesandcurrents.noaa.gov/map/";
    renderTidePanelMessage(
      `<p class="tide-panel-note tide-panel-err">${escapeHtml(msg)} <a href="${mapUrl}" target="_blank" rel="noopener">NOAA tides map</a></p>`
    );
  }

  function updateDataFreshFooter(maxGenMs) {
    if (!el.dataFresh) return;
    const when = new Date();
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
    const lineA = `Loaded ${when.toLocaleString()} (${tzName}).`;
    const lineB =
      maxGenMs > 0
        ? ` Open-Meteo reported API build time up to ${maxGenMs.toFixed(0)} ms (server processing), not the model run time.`
        : "";
    el.dataFresh.textContent = lineA + lineB;
  }

  function setStatus(msg, isErr) {
    if (!msg) {
      el.status.hidden = true;
      el.status.textContent = "";
      el.status.classList.toggle("error", false);
      return;
    }
    el.status.hidden = false;
    el.status.textContent = msg;
    el.status.classList.toggle("error", !!isErr);
  }

  function applyPreset(p) {
    lat = p.lat;
    lon = p.lon;
    tz = p.tz;
    placeName = p.name;
    placeShort = p.short;
    currentNoaaId = p.noaaId ?? null;
    renderTideLine();
    el.locPanel.classList.remove("open");
    load();
  }

  function renderPresetButtons(container, list) {
    if (!container) return;
    container.innerHTML = list
      .map((p) => {
        const payload = encodeURIComponent(
          JSON.stringify({
            lat: p.lat,
            lon: p.lon,
            tz: p.tz,
            name: p.name,
            short: p.short,
            noaaId: p.noaaId ?? null,
          })
        );
        return `<button type="button" class="pick" data-preset="${payload}"><strong>${escapeHtml(p.short)}</strong><span style="color:#5a7285;font-weight:400"> — ${escapeHtml(p.name)}</span></button>`;
      })
      .join("");
    container.querySelectorAll("button.pick").forEach((btn) => {
      btn.addEventListener("click", () => {
        try {
          applyPreset(JSON.parse(decodeURIComponent(btn.dataset.preset)));
        } catch {
          /* ignore */
        }
      });
    });
  }

  function renderPresets() {
    renderPresetButtons(el.presetListSf, PRESETS_SOUTH_FL);
    renderPresetButtons(el.presetListOther, PRESETS_OTHER);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function searchGeo(q) {
    if (!q || q.trim().length < 2) return;
    const geoHost = document.getElementById("geo-results");
    try {
      const url = `${GEO_URL}?${new URLSearchParams({ name: q.trim(), count: "10", language: "en", format: "json" })}`;
      const data = await fetchJson(url);
      const res = data.results ?? [];
      geoHost.innerHTML = "";
      if (!res.length) {
        geoHost.innerHTML = '<p style="margin:0.5rem;font-size:0.8rem;color:#5a7285">No matches.</p>';
        return;
      }
      for (const r of res) {
        const admin = [r.admin1, r.country_code].filter(Boolean).join(", ");
        const label = [r.name, admin].filter(Boolean).join(" — ");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pick geo";
        btn.innerHTML = `<strong>${escapeHtml(r.name)}</strong><span style="color:#5a7285;font-weight:400"> — ${escapeHtml(admin)}</span>`;
        btn.addEventListener("click", () => {
          lat = r.latitude;
          lon = r.longitude;
          tz = r.timezone || guessTimezone(r.latitude, r.longitude);
          placeName = label;
          placeShort = r.name;
          currentNoaaId = null;
          renderTideLine();
          selectedKey = null;
          el.locPanel.classList.remove("open");
          load();
        });
        geoHost.appendChild(btn);
      }
    } catch {
      geoHost.innerHTML = '<p style="margin:0.5rem;font-size:0.8rem;color:#b00020">Search failed. Try again.</p>';
    }
  }

  el.locBtn.addEventListener("click", () => {
    el.locPanel.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!el.locPanel.contains(e.target) && e.target !== el.locBtn && !el.locBtn.contains(e.target)) {
      el.locPanel.classList.remove("open");
    }
  });

  el.locSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => searchGeo(el.locSearch.value), 380);
  });

  el.btnRefresh?.addEventListener("click", () => load());

  el.btnUseGeo?.addEventListener("click", () => {
    if (!navigator.geolocation) {
      setStatus("Your browser does not support geolocation. Use search or a preset.", true);
      return;
    }
    setStatus("Getting your location…");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        lat = pos.coords.latitude;
        lon = pos.coords.longitude;
        tz = guessTimezone(lat, lon);
        currentNoaaId = null;
        selectedKey = null;
        try {
          const revUrl = `${GEO_URL}?${new URLSearchParams({
            latitude: String(lat),
            longitude: String(lon),
            count: "1",
            language: "en",
            format: "json",
          })}`;
          const data = await fetchJson(revUrl);
          const r = data.results?.[0];
          if (r) {
            placeName = [r.name, r.admin1, r.country_code].filter(Boolean).join(", ");
            placeShort = r.name;
            tz = r.timezone || guessTimezone(lat, lon);
          } else {
            placeShort = "My location";
            placeName = `My location (${lat.toFixed(3)}°, ${lon.toFixed(3)}°)`;
          }
        } catch {
          placeShort = "My location";
          placeName = `My location (${lat.toFixed(3)}°, ${lon.toFixed(3)}°)`;
        }
        renderTideLine();
        el.locPanel.classList.remove("open");
        setStatus("");
        load();
      },
      (err) => {
        const msg =
          err.code === 1
            ? "Location permission denied — use a saved spot or search instead."
            : err.code === 2
              ? "Location unavailable — try again or pick a preset."
              : "Could not read GPS — pick a preset or search.";
        setStatus(msg, true);
      },
      { enableHighAccuracy: true, timeout: 18000, maximumAge: 600000 }
    );
  });

  async function load() {
    el.locLabel.textContent = placeShort;
    setStatus("Loading forecast…");
    el.main.hidden = true;
    updateWindyEmbed();
    if (currentNoaaId) renderTidePanelMessage('<p class="tide-panel-note">Loading NOAA tides…</p>');
    else renderTidePanelNoStation();

    async function safeTides() {
      if (!currentNoaaId) return { mode: "none" };
      try {
        const preds = await fetchNoaaHiloPredictions(currentNoaaId, tz);
        return { mode: "ok", preds };
      } catch (e) {
        return { mode: "err", msg: e?.message || "Could not load NOAA tides." };
      }
    }

    try {
      const [marine, weather, tideResult] = await Promise.all([
        fetchJson(buildMarineParams(lat, lon, tz)),
        fetchJson(buildWeatherParams(lat, lon, tz)),
        safeTides(),
      ]);
      if (tideResult.mode === "ok") renderTidePanelFromPredictions(tideResult.preds, currentNoaaId);
      else if (tideResult.mode === "err") renderTidePanelError(tideResult.msg);
      else renderTidePanelNoStation();
      merged = mergeSeries(marine, weather);
      if (!merged.length) throw new Error("No overlapping hourly data for this location.");

      const maxGen = Math.max(marine.generationtime_ms ?? 0, weather.generationtime_ms ?? 0);
      updateDataFreshFooter(maxGen);
      const lowMarine = assessLowMarineConfidence(merged);
      if (el.confidenceBanner) {
        if (lowMarine) {
          el.confidenceBanner.hidden = false;
          el.confidenceBanner.textContent =
            "Marine data thin here: swell and combined wave heights are often missing at this grid (common well inside bays or far from the surf zone). Treat swell- and wave-driven parts of the score as low confidence and rely on local observation.";
        } else {
          el.confidenceBanner.hidden = true;
        }
      }

      const allKeys = [...new Set(merged.map((r) => dateKeyFromApiLocal(r.time)))].sort();
      const today = todayKeyForTz(tz);
      let keys = allKeys.filter((k) => k >= today).slice(0, 7);
      if (keys.length === 0) keys = allKeys.slice(-7);
      dayKeys = keys;

      if (!selectedKey || !dayKeys.includes(selectedKey)) {
        selectedKey = dayKeys[0] || allKeys[0];
      }

      const scored = dayKeys.map((k) => {
        const stats = aggregateDay(merged, k);
        if (!stats) return { key: k, overall: 0, stats: null };
        const bd = breakdownForDay(stats, merged, k);
        return { key: k, overall: bd.overall, stats, bd };
      });

      const scoredValid = scored.filter((d) => d.stats);
      const best = scoredValid.reduce((a, b) => (b.overall > a.overall ? b : a), scoredValid[0]);

      el.dayGrid.innerHTML = scored
        .map((d, idx) => {
          if (!d.stats) return "";
          const bestMark = best && d.key === best.key && best.overall >= 70 ? `<span class="badge-best">Best</span>` : "";
          const wind = d.stats.windMaxKn ?? 0;
          const swell = d.stats.swellMaxFt ?? 0;
          const per = d.stats.swellMinS ?? 0;
          const lab = formatDayLabel(d.key, today, idx);
          const selClass = d.key === selectedKey ? "selected" : "";
          return `<button type="button" class="day-card ${selClass}" data-key="${d.key}">
            ${bestMark}
            <div class="date-line">${escapeHtml(lab)}</div>
            <div class="score-big">${d.overall} <span style="font-size:0.55em;font-weight:700;color:#5a7285">/ 100</span></div>
            <div class="rating">${escapeHtml(labelForScore(d.overall))}</div>
            <div class="mini">Wind ${wind.toFixed(0)}kt · Swell ${swell.toFixed(1)}ft · ${per.toFixed(0)}s</div>
          </button>`;
        })
        .join("");

      el.dayGrid.querySelectorAll(".day-card").forEach((card) => {
        card.addEventListener("click", () => {
          selectedKey = card.dataset.key;
          el.dayGrid.querySelectorAll(".day-card").forEach((c) => c.classList.remove("selected"));
          card.classList.add("selected");
          renderDetail(scored);
        });
      });

      renderDetail(scored);
      setStatus("");
      el.main.hidden = false;
    } catch (e) {
      console.error(e);
      if (el.confidenceBanner) el.confidenceBanner.hidden = true;
      if (el.dataFresh) el.dataFresh.textContent = "";
      setStatus(e.message || "Could not load forecast.", true);
    }
  }

  function renderDetail(scored) {
    const day = scored.find((d) => d.key === selectedKey);
    if (!day || !day.stats) return;

    const { stats, bd } = day;
    const niceDate = longDateLabel(selectedKey);

    const circ = 2 * Math.PI * 40;
    const off = circ * (1 - bd.overall / 100);
    el.donutFg.style.strokeDasharray = `${circ}`;
    el.donutFg.style.strokeDashoffset = `${off}`;
    el.donutNum.textContent = String(bd.overall);
    el.detailLoc.textContent = `${placeName} — ${niceDate}`;
    el.pillStatus.textContent = `${labelForScore(bd.overall)} for shore diving`;
    el.pillStatus.className = "pill-status " + ratingClass(bd.overall);

    el.statWind.textContent = `${(stats.windMaxKn ?? 0).toFixed(0)} kn ${degToCompass(stats.windDirAtMax)}`;
    el.statSwell.textContent = `${(stats.swellMaxFt ?? 0).toFixed(1)} ft ${(stats.swellMinS ?? 0).toFixed(0)}s`;
    const air = stats.airTempAvgF != null ? stats.airTempAvgF.toFixed(0) : "—";
    const sea = stats.sstAvgF != null ? stats.sstAvgF.toFixed(0) : "—";
    el.statTemp.textContent = `${air}° / ${sea}° F`;
    el.statVis.textContent = `${(stats.visMinMi ?? 0).toFixed(1)} mi`;

    el.breakdown.innerHTML = bd.factors
      .map((f) => {
        const barClass = f.warn ? (f.score < 55 ? "bad" : "warn") : "";
        const panelId = `why-${f.id}`;
        return `<div class="factor">
          <div class="factor-head"><span class="name">${escapeHtml(f.name)}</span><span class="meta">${escapeHtml(f.value)} · ${f.score}/100</span></div>
          <div class="bar-track"><div class="bar-fill ${barClass}" style="width:${f.score}%"></div></div>
          <div class="note">${escapeHtml(f.note)}</div>
          <div class="weight">Weight in score: ${f.weightPct}%</div>
          <button type="button" class="factor-why-btn" aria-expanded="false" aria-controls="${panelId}">Why this score?</button>
          <div class="factor-why-panel" id="${panelId}" hidden>${escapeHtml(f.why)}</div>
        </div>`;
      })
      .join("");

    el.breakdown.querySelectorAll(".factor-why-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const panelId = btn.getAttribute("aria-controls");
        const panel = panelId ? document.getElementById(panelId) : null;
        if (!panel) return;
        const open = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", open ? "false" : "true");
        panel.hidden = open;
      });
    });

    render48hCharts();
    const rain = bd.wp.rain48in.toFixed(2);
    const avgs = bd.wp.maxSwell48ft.toFixed(2);
    el.alert48.innerHTML = `<strong>Recent swell or runoff</strong> — visibility in the water may be worse than air visibility suggests. 48h rain max equivalent ~${rain} in cumulative hourly precip; max swell ~${avgs} ft in the series window.`;

    const [y, m, d] = selectedKey.split("-").map(Number);
    const wday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(y, m - 1, d).getDay()];
    const mon = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1];
    el.hourlyTitle.textContent = `Hourly — ${wday}, ${mon} ${d}`;

    const hours = merged.filter((r) => dateKeyFromApiLocal(r.time) === selectedKey).sort((a, b) => a.time.localeCompare(b.time));
    el.hourStrip.innerHTML = hours
      .map((r) => {
        const h = hourFromApiLocal(r.time);
        const hour12 = h % 12 || 12;
        const ampm = h >= 12 ? "p" : "a";
        const tlab = `${hour12}${ampm}`;
        const tf = cToF(r.temp_c);
        const temp = tf != null ? `${tf.toFixed(0)}°` : "—";
        const w = r.wind_kn ?? 0;
        const sf = (r.swell_m ?? 0) * M_TO_FT;
        const ss = r.swell_s ?? 0;
        return `<div class="hour-col"><div class="t">${tlab}</div><div class="temp">${temp}</div><div class="row">${w.toFixed(0)} ${degToCompass(r.wind_dir)}</div><div class="row">${sf.toFixed(1)}ft ${ss.toFixed(0)}s</div></div>`;
      })
      .join("");
  }

  function render48hCharts() {
    const slice = merged.slice(-48);
    if (slice.length < 2) {
      el.chartSwell.innerHTML = '<text x="4" y="44" font-size="10" fill="#5a7285">Not enough past hours in this response.</text>';
      el.chartRain.innerHTML = "";
      return;
    }

    const swellFt = slice.map((r) => (r.swell_m ?? 0) * M_TO_FT);
    const rainIn = slice.map((r) => ((r.precip_mm ?? 0) / 25.4));

    drawLineChart(el.chartSwell, swellFt, "#1e6bb8", "ft");
    drawLineChart(el.chartRain, rainIn, "#0d8a5b", "in/hr");
  }

  function drawLineChart(svgEl, values, color, unitHint) {
    const W = 360;
    const H = 88;
    const pad = 6;
    const max = Math.max(0.01, ...values);
    const pts = values
      .map((v, i) => {
        const x = pad + (i / Math.max(1, values.length - 1)) * (W - pad * 2);
        const y = H - pad - (v / max) * (H - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    svgEl.innerHTML = `
      <polyline points="${pts}" stroke="${color}" />
      <text x="${W - 4}" y="12" text-anchor="end" font-size="9" fill="#5a7285">max ${max.toFixed(2)} ${unitHint}</text>
    `;
  }

  renderTideLine();
  renderPresets();
  load();
}

document.addEventListener("DOMContentLoaded", init);
