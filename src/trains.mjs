import { ServiceError } from './errors.mjs';

const taipeiFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function taipeiTime(instant = new Date()) {
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new ServiceError('INVALID_TIME');
  const p = Object.fromEntries(taipeiFormatter.formatToParts(instant).map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    seconds: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) + instant.getMilliseconds() / 1000,
  };
}

export function parseTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2}):([0-5]\d)(?::([0-5]\d))?$/.exec(value);
  if (!match || Number(match[1]) > 47) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
}

function trainType(info) {
  const code = String(info.TrainTypeCode || '');
  if (code === '6') return '區間車';
  if (code === '10') return '區間快';
  return info.TrainTypeName?.Zh_tw?.split(/[（(]/)[0]?.trim() || '列車';
}

export function upcomingTrains(trains, fromId, toId, instant, {
  limit = 3, leadMinutes = 0, typeCodes = [], afterSeconds = 0,
} = {}) {
  if (!Array.isArray(trains)) throw new ServiceError('TDX_INVALID_DATA');
  const cutoff = Math.max(taipeiTime(instant).seconds + leadMinutes * 60, afterSeconds);
  const found = new Map();
  for (const row of trains) {
    const info = row?.TrainInfo;
    if (!info || !Array.isArray(row.StopTimes) || typeof info.TrainNo !== 'string') {
      throw new ServiceError('TDX_INVALID_DATA');
    }
    // 停駛與部分停駛皆保守排除；郵輪／專列也不當成一般通勤班次。
    if (Number(info.SuspendedFlag || 0) !== 0 || [3, 4].includes(Number(info.ServiceType))) continue;
    if (typeCodes.length && !typeCodes.includes(String(info.TrainTypeCode))) continue;
    const from = row.StopTimes.find(x => x?.StationID === fromId);
    const to = row.StopTimes.find(x => x?.StationID === toId);
    if (!from || !to || !Number.isFinite(from.StopSequence) || !Number.isFinite(to.StopSequence)) {
      throw new ServiceError('TDX_INVALID_DATA');
    }
    if (from.StopSequence >= to.StopSequence) continue;
    if (Number(from.SuspendedFlag || 0) !== 0 || Number(to.SuspendedFlag || 0) !== 0) continue;
    const departureSeconds = parseTime(from.DepartureTime);
    const arrivalSeconds = parseTime(to.ArrivalTime);
    // 缺少離站時間表示無可用的上車時刻；不以到站時間冒充離站時間。
    if (departureSeconds === null || arrivalSeconds === null) continue;
    // 嚴格「現在之後」；24:xx 以上屬於隔日，不混進今天的清單。
    if (departureSeconds <= cutoff || departureSeconds >= 86400) continue;
    const item = {
      number: info.TrainNo,
      type: trainType(info),
      departure: from.DepartureTime.slice(0, 5),
      arrival: `${String(Math.floor(arrivalSeconds / 3600) % 24).padStart(2, '0')}:${to.ArrivalTime.slice(3, 5)}`,
      arrivalDayOffset: Math.floor((arrivalSeconds < departureSeconds ? arrivalSeconds + 86400 : arrivalSeconds) / 86400),
      departureSeconds,
      afterDestination: row.StopTimes.filter(x => x.StopSequence > to.StopSequence).map(x => x.StationID),
    };
    found.set(`${item.number}:${departureSeconds}`, item);
  }
  return [...found.values()].sort((a, b) => a.departureSeconds - b.departureSeconds || a.number.localeCompare(b.number)).slice(0, limit);
}

export class TrainService {
  constructor(tdx, config) {
    this.tdx = tdx;
    this.config = config;
  }

  async lookup(route, instant, { exclude = null } = {}) {
    const signal = AbortSignal.timeout(this.config.tdxTimeoutMs);
    const current = taipeiTime(instant);
    const { from, to } = await this.tdx.resolveStations(route.from, route.to, signal);
    const timetable = await this.tdx.getTimetable(from.id, to.id, current.date, signal);
    return {
      from: from.name, to: to.name, fromId: from.id, toId: to.id, date: current.date, time: current.time,
      trains: upcomingTrains(exclude ? timetable.trains.filter(row => !(row.TrainInfo?.TrainNo === exclude.number
        && row.StopTimes?.find(x => x.StationID === from.id)?.DepartureTime?.slice(0, 5) === exclude.departure)) : timetable.trains, from.id, to.id, instant, {
        limit: this.config.resultLimit, leadMinutes: this.config.minLeadMinutes, typeCodes: this.config.trainTypeCodes,
        afterSeconds: exclude ? parseTime(exclude.departure) ?? 0 : 0,
      }),
      leadMinutes: this.config.minLeadMinutes,
      filtered: this.config.trainTypeCodes.length > 0,
    };
  }
}
