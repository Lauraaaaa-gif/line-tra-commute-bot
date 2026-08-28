import { taipeiTime } from './trains.mjs';

export function trainTimes(result, train) {
  const departureAt = Date.parse(`${result.date}T${train.departure}:00+08:00`);
  const arrivalAt = Date.parse(`${result.date}T${train.arrival}:00+08:00`) + (train.arrivalDayOffset || 0) * 86400000;
  return { departureAt, arrivalAt };
}

export class RealtimeService {
  constructor(tdx, { clock = Date.now, cacheMs = 60000, maxAgeMs = 300000 } = {}) {
    this.tdx = tdx; this.clock = clock; this.cacheMs = cacheMs; this.maxAgeMs = maxAgeMs;
    this.cache = new Map();
  }
  async get(number) {
    if (!/^\d{1,8}$/.test(number)) return null;
    const hit = this.cache.get(number);
    if (hit && hit.until > this.clock()) return hit.promise;
    const promise = this.tdx.get(`/TrainLiveBoard/TrainNo/${number}`, { '$top': '10' }, AbortSignal.timeout(3000))
      .then(data => Array.isArray(data?.TrainLiveBoards) ? data.TrainLiveBoards : [])
      .catch(() => []);
    this.cache.set(number, { until: this.clock() + this.cacheMs, promise });
    for (const [key, item] of this.cache) if (item.until <= this.clock()) this.cache.delete(key);
    while (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
    return promise;
  }
  async view(result, train, instant) {
    const times = trainTimes(result, train);
    const now = instant.getTime();
    // 未接近本趟乘車時間，不把尚未發車車次的殘留位置當成即時行程。
    if (now < times.departureAt - 1800000 || now > times.arrivalAt + 21600000) return scheduledView(result, train);
    const rows = await this.get(train.number);
    const row = (rows || []).filter(x => x?.TrainNo === train.number).sort((a, b) => Date.parse(b.UpdateTime) - Date.parse(a.UpdateTime))[0];
    const updatedAt = Date.parse(row?.UpdateTime);
    const delay = row?.DelayTime;
    const valid = Number.isFinite(updatedAt) && updatedAt <= now + 60000 && now - updatedAt <= this.maxAgeMs
      && Number.isInteger(delay) && delay >= -10 && delay <= 360
      && taipeiTime(new Date(updatedAt)).date >= result.date
      && taipeiTime(new Date(updatedAt)).date <= taipeiTime(new Date(times.arrivalAt)).date;
    return { ...times, known: Boolean(valid), delay: valid ? Math.max(0, delay) : null,
      etaAt: times.arrivalAt + (valid ? Math.max(0, delay) * 60000 : 0),
      updatedAt: valid ? updatedAt : null,
      reached: Boolean(valid && (row.StationID === result.toId && [1, 2].includes(row.TrainStationStatus)
        || train.afterDestination?.includes(row.StationID))),
    };
  }
}

export function scheduledView(result, train) {
  const times = trainTimes(result, train);
  return { ...times, etaAt: times.arrivalAt, known: false, delay: null, reached: false };
}
