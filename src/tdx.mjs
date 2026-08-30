import { requestJson, runtimeFetch } from './http-client.mjs';
import { ServiceError } from './errors.mjs';

const TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const API_ROOT = 'https://tdx.transportdata.tw/api/basic/v3/Rail/TRA';

export function normalizeStationName(name) {
  return String(name).normalize('NFKC').trim().replace(/台/g, '臺').replace(/(?:火車站|車站|站)$/, '');
}

export class TdxClient {
  constructor({ clientId, clientSecret, fetchImpl = runtimeFetch, clock = Date.now, cacheMs = 60000, pageSize = 1000 }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.cacheMs = cacheMs;
    this.pageSize = pageSize;
    this.token = null;
    this.tokenRequest = null;
    this.stations = null;
    this.cache = new Map();
  }

  async getToken(signal) {
    if (this.token && this.token.expiresAt > this.clock()) return this.token.value;
    // 一次冷啟動只換一個 token；不把 client secret 記入 log。
    if (!this.tokenRequest) {
      this.tokenRequest = (async () => {
        const data = await requestJson(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret,
          }),
        }, { fetchImpl: this.fetchImpl, signal, service: 'TDX' });
        const life = Number(data?.expires_in);
        if (typeof data?.access_token !== 'string' || !data.access_token || !Number.isFinite(life) || life <= 0) {
          throw new ServiceError('TDX_INVALID_TOKEN');
        }
        const margin = Math.min(60000, life * 100);
        this.token = { value: data.access_token, expiresAt: this.clock() + life * 1000 - margin };
        return this.token.value;
      })().finally(() => { this.tokenRequest = null; });
    }
    return this.tokenRequest;
  }

  async get(path, parameters, signal) {
    const url = new URL(API_ROOT + path);
    url.search = new URLSearchParams({ '$format': 'JSON', ...parameters }).toString();
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken(signal);
      try {
        return await requestJson(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
          { fetchImpl: this.fetchImpl, signal, service: 'TDX' });
      } catch (error) {
        // 僅 401 換 token 重試一次；429／5xx 不做重試風暴。
        if (error.status !== 401 || attempt === 1) throw error;
        if (this.token?.value === token) this.token = null;
      }
    }
  }

  async allPages(path, arrayKey, signal, date) {
    const result = [];
    let updateTime = null;
    let previousPage = null;
    for (let page = 0; page < 20; page++) {
      const data = await this.get(path, {
        '$top': String(this.pageSize), '$skip': String(result.length), '$count': 'true',
      }, signal);
      if (!data || typeof data !== 'object' || !(arrayKey in data)) throw new ServiceError('TDX_INVALID_DATA');
      if (date && data.TrainDate !== date) throw new ServiceError('TDX_DATE_MISMATCH');
      const items = data[arrayKey] === null && arrayKey === 'TrainTimetables' ? [] : data[arrayKey];
      if (!Array.isArray(items)) throw new ServiceError('TDX_INVALID_DATA');
      const fingerprint = JSON.stringify(items);
      if (items.length && fingerprint === previousPage) throw new ServiceError('TDX_PAGINATION_ERROR');
      previousPage = fingerprint;
      result.push(...items);
      updateTime ||= data.UpdateTime || null;
      const count = data.Count;
      if (!items.length || (Number.isInteger(count) && count >= 0 && result.length >= count)) {
        return { items: result, updateTime };
      }
      // 沒有 Count 時也抓到空頁才停止，避免服務端把 top 限制成較小值。
    }
    throw new ServiceError('TDX_TOO_MANY_PAGES');
  }

  async resolveStations(fromName, toName, signal) {
    if (!this.stations || this.stations.expiresAt <= this.clock()) {
      const result = await this.allPages('/Station', 'Stations', signal);
      if (!result.items.length) throw new ServiceError('TDX_INVALID_STATIONS');
      const index = new Map();
      for (const station of result.items) {
        if (typeof station?.StationName?.Zh_tw !== 'string') continue;
        const key = normalizeStationName(station.StationName.Zh_tw);
        const matches = index.get(key) || [];
        matches.push(station);
        index.set(key, matches);
      }
      this.stations = { index, expiresAt: this.clock() + 86400000 };
    }
    const find = name => {
      const matches = this.stations.index.get(normalizeStationName(name)) || [];
      if (matches.length !== 1 || !/^\d{4}$/.test(matches[0].StationID)) {
        const error = new ServiceError('STATION_NOT_FOUND');
        error.stationName = String(name).trim().slice(0, 30);
        throw error;
      }
      return { id: matches[0].StationID, name: matches[0].StationName.Zh_tw };
    };
    const from = find(fromName);
    const to = find(toName);
    if (from.id === to.id) throw new ServiceError('SAME_STATION');
    return { from, to };
  }

  async getTimetable(fromId, toId, date, signal) {
    if (!/^\d{4}$/.test(fromId) || !/^\d{4}$/.test(toId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new ServiceError('INVALID_QUERY');
    }
    const key = `${date}:${fromId}:${toId}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.clock()) return hit.value;
    const result = await this.allPages(`/DailyTrainTimetable/OD/${fromId}/to/${toId}/${date}`, 'TrainTimetables', signal, date);
    const value = { date, trains: result.items, updateTime: result.updateTime };
    this.cache.set(key, { value, expiresAt: this.clock() + this.cacheMs });
    // 路線和日期是 cache key 的一部分，跨日不會讀到昨天的班表。
    for (const [k, entry] of this.cache) if (entry.expiresAt <= this.clock()) this.cache.delete(k);
    while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
    return value;
  }
}
