/**
 * Пресеты звучания. Пресет задаёт только отличия от настроек по умолчанию:
 * при выборе всё, что в нём не указано, возвращается к умолчанию (коррекция наушников не трогается).
 */
export const PRESET_KEYS = [
  'intensity', 'balance', 'bass', 'clarity', 'bright', 'compAmount', 'deessBias', 'widthScale', 'ceiling', 'drive',
  'enhBass', 'enhPunch', 'enhAir', 'stemKick', 'stemBass', 'unmask', 'recover', 'restore', 'headroom', 'color', 'spaceDuck', 'smart', 'bassLimit', 'antiboom', 'surround', 'surroundAmount', 'surroundDevice', 'loudComp', 'manualEq', 'fx',
  'juice', 'space', 'reverb', 'reverbSize', 'delay', 'delayFeedback', 'delayNote',
];

export const PRESETS = {
  auto: { name: 'Авто — рекомендуется', values: {} },
  studio: {
    name: 'Студия',
    // плотно, близко и чисто: короткая комната, без дилея, собранная динамика, чёткий центр
    values: { juice: 0.75, space: 0.35, reverb: 0.09, reverbSize: 'room', delay: 0, compAmount: 1.25, clarity: 1, enhBass: 1.1, enhPunch: 1.2, enhAir: 1.1, smart: 0.8 },
  },
  stadium: {
    name: 'Стадион',
    // огромное пространство: длинный хвост, дилей на четверть такта, широко, мощный низ
    values: {
      juice: 0.85, space: 0.8, reverb: 0.24, reverbSize: 'stadium', delay: 0.12, delayFeedback: 0.35, delayNote: 1,
      surround: '5.1', surroundAmount: 0.5, widthScale: 1.2, compAmount: 1.4, enhBass: 1.3, enhPunch: 1.4, enhAir: 1.2, bass: 1.5,
    },
  },
  hifi: { name: 'Чистый Hi-Fi', values: { balance: 0.35, enhBass: 0.4, enhPunch: 0.5, enhAir: 0.4, smart: 0.35, compAmount: 0.5, intensity: 0.4 } },
  bass: { name: 'Глубокий бас', values: { bass: 2.5, enhBass: 1.6, enhPunch: 1.3, enhAir: 1, smart: 0.8, bassLimit: -11 } },
  vocal: { name: 'Вокал и подкасты', values: { clarity: 2.5, bass: -1, deessBias: 0.15, enhBass: 0.6, enhPunch: 0.6, enhAir: 1, smart: 0.7 } },
  cinema: { name: 'Кино 7.1', values: { surround: '7.1', surroundAmount: 0.7, enhBass: 1.3, enhPunch: 1.3, enhAir: 1.1, smart: 0.8 } },
  concert: { name: 'Концерт 5.1', values: { surround: '5.1', surroundAmount: 0.5, widthScale: 1.15, intensity: 1.2, enhPunch: 1.2 } },
  night: { name: 'Ночной (тихо, но разборчиво)', values: { compAmount: 1.8, smart: 1, enhBass: 1.3, enhPunch: 0.8, enhAir: 1.3, loudComp: true, bass: 1 } },
};

/**
 * Пресеты эквалайзера — ручные правки (дБ) поверх автоподстройки, полосы:
 * 32, 64, 125, 250 Гц, 500 Гц, 1, 2, 4, 8, 16 кГц.
 * Подъёмы умеренные и без «гудящей» зоны 125–500 Гц: звук ярче и плотнее, а не просто громче
 * (общую громкость всё равно выравнивает автогромкость).
 */
export const EQ_PRESETS = {
  flat:     { name: 'Ровно (без правок)', eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bassUp:   { name: 'Больше баса',        eq: [4, 3.5, 1.5, 0, 0, 0, 0, 0, 0, 0] },
  bassDown: { name: 'Меньше баса',        eq: [-4, -3, -1.5, -0.5, 0, 0, 0, 0, 0, 0] },
  vshape:   { name: 'Вечеринка (V)',      eq: [3.5, 3, 1, -0.5, -1.5, -1, 0, 1.5, 2.5, 3] },
  warm:     { name: 'Тёплый',             eq: [2, 2, 1, 0.5, 0, 0, -0.5, -1, -1.5, -1.5] },
  bright:   { name: 'Яркий',              eq: [0, 0, 0, -0.5, -0.5, 0, 0.5, 1.5, 2.5, 3] },
  vocal:    { name: 'Вокал',              eq: [-1.5, -1, -0.5, -1, 0, 1, 2, 1.5, 0.5, 0] },
  rock:     { name: 'Рок',                eq: [3, 2.5, 1, -0.5, -1, 0, 1, 2, 2, 1.5] },
  electro:  { name: 'Электроника',        eq: [4, 3.5, 1, -0.5, -1, 0, 0, 1, 2, 2.5] },
  hiphop:   { name: 'Хип-хоп',            eq: [4.5, 4, 1.5, 0, -1, -0.5, 0.5, 1, 0.5, 1] },
  acoustic: { name: 'Акустика и классика', eq: [1, 1, 0.5, 0, 0, 0, 0.5, 1, 1, 1] },
  speech:   { name: 'Речь и подкасты',    eq: [-4, -3, -1, 0, 0.5, 1.5, 2.5, 2, 0, -1] },
  soft:     { name: 'Убрать резкость',    eq: [0, 0, 0, 0, 0, 0, -1, -2.5, -2, -1] },
  quiet:    { name: 'Тихое прослушивание', eq: [3.5, 3, 1, 0, 0, 0, 0.5, 0.5, 1.5, 2] },
};
