// 全為人工示範／測試資料；不是 2026-08-28 的真實班表。
export function train(number, departure, {
  from = '4340', to = '4290', arrival = departure, code = '6', name = '區間',
  suspended = 0, fromSuspended = 0, toSuspended = 0, serviceType = 1,
} = {}) {
  return {
    TrainInfo: {
      TrainNo: number, TrainTypeCode: code, TrainTypeName: { Zh_tw: name },
      SuspendedFlag: suspended, ServiceType: serviceType,
    },
    StopTimes: [
      { StopSequence: 1, StationID: from, StationName: { Zh_tw: '新左營' }, ArrivalTime: departure, DepartureTime: departure, SuspendedFlag: fromSuspended },
      { StopSequence: 2, StationID: to, StationName: { Zh_tw: '大湖' }, ArrivalTime: arrival, DepartureTime: arrival, SuspendedFlag: toSuspended },
    ],
  };
}

export function sampleTrains() {
  return [
    train('3246', '18:25'), train('3200', '17:30'), train('3238', '17:48'),
    train('3242', '18:02'), train('3018', '18:16', { code: '10', name: '區間快' }),
    train('3250', '18:40'),
  ];
}

export const stations = [
  { StationID: '4290', StationName: { Zh_tw: '大湖' } },
  { StationID: '4340', StationName: { Zh_tw: '新左營' } },
  { StationID: '1000', StationName: { Zh_tw: '臺北' } },
];

export const silentLogger = { error() {}, log() {} };
export const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
