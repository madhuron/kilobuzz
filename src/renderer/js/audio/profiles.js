export const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/**
 * Базовые профили стилей.
 *  eq      — усиление по полосам EQ_FREQS, дБ
 *  comp    — thr: смещение порога от средней громкости трека (дБ); ratio/attack/release/mix
 *  deess   — интенсивность де-эссера 0..1
 *  width   — ширина стерео (1 = как есть)
 *  dynamic — насколько сильно стиль реагирует на смену секций (классике не нужен «дроп»)
 */
export const GENRES = {
  edm:       { name: 'Электроника', eq: [4, 4.5, 2.5, -1, -1.5, -0.5, 0.5, 1.5, 2.5, 3],   comp: { thr: -1, ratio: 3,   attack: 20, release: 120, mix: 0.85 },  deess: 0.35, width: 1.15, dynamic: 1 },
  hiphop:    { name: 'Хип-хоп',     eq: [5, 5, 3, 0, -1.5, -0.5, 1, 1.5, 1, 1.5],          comp: { thr: -1, ratio: 3,   attack: 15, release: 140, mix: 0.85 },  deess: 0.55, width: 1.05, dynamic: 0.9 },
  rock:      { name: 'Рок',         eq: [2, 2.5, 1.5, -0.5, -1, 0, 1.5, 2.5, 2, 1.5],      comp: { thr: -2, ratio: 2.5, attack: 12, release: 150, mix: 0.75 },  deess: 0.45, width: 1.1,  dynamic: 0.8 },
  metal:     { name: 'Метал',       eq: [2, 3, 1, -1.5, -2, -0.5, 1.5, 2.5, 2, 1],          comp: { thr: 0,  ratio: 2,   attack: 10, release: 120, mix: 0.65 }, deess: 0.4,  width: 1.05, dynamic: 0.7 },
  pop:       { name: 'Поп',         eq: [2, 2.5, 1.5, -0.5, -1, 0, 1, 2, 2.5, 2.5],         comp: { thr: -2, ratio: 2.5, attack: 15, release: 150, mix: 0.80 }, deess: 0.6,  width: 1.1,  dynamic: 0.9 },
  rnb:       { name: 'R&B / Соул',  eq: [3.5, 4, 2.5, 0.5, -1, -0.5, 0.5, 1.5, 2, 2],       comp: { thr: -2, ratio: 2.2, attack: 20, release: 180, mix: 0.75 },  deess: 0.6,  width: 1.1,  dynamic: 0.8 },
  jazz:      { name: 'Джаз',        eq: [1, 1.5, 1, 0.5, 0, 0, 0.5, 1, 1.5, 1.5],           comp: { thr: -3, ratio: 1.8, attack: 30, release: 250, mix: 0.60 },  deess: 0.3,  width: 1.1,  dynamic: 0.5 },
  classical: { name: 'Классика',    eq: [0.5, 1, 0.5, 0, 0, 0, 0, 0.5, 1, 1.5],             comp: { thr: -4, ratio: 1.6, attack: 40, release: 350, mix: 0.50 },  deess: 0.15, width: 1.15, dynamic: 0.35 },
  acoustic:  { name: 'Акустика',    eq: [0.5, 1, 0.5, -0.5, 0, 0.5, 1, 1.5, 1.5, 1.5],      comp: { thr: -3, ratio: 2,   attack: 25, release: 220, mix: 0.65 }, deess: 0.5,  width: 1.1,  dynamic: 0.6 },
  lofi:      { name: 'Lo-fi / Chill', eq: [2.5, 3, 2, 1, 0, -0.5, -0.5, -1, -1.5, -2],      comp: { thr: -2, ratio: 3,   attack: 30, release: 200, mix: 0.80 }, deess: 0.3,  width: 1.05, dynamic: 0.6 },
};

/**
 * Поправки секций поверх стиля.
 *  tc — постоянная времени перехода (с): дроп «включается» почти мгновенно, остальное — плавно.
 */
export const SECTIONS = {
  intro:        { name: 'Вступление', color: '#7aa2ff', eq: [-0.5, -0.5, 0, 0, 0, 0, 0, 0.5, 1, 1],           thr: 3,  ratio: 0.9, width: 0.05, deess: 0,    tc: 1.0, desc: 'Мягко, с воздухом — оставляем место для развития' },
  verse:        { name: 'Куплет',     color: '#5eead4', eq: [-0.5, -0.5, -0.5, -0.5, -0.5, 0, 1, 1.5, 0.5, 0], thr: 1,  ratio: 1,   width: 0,    deess: 0.15, tc: 0.8, desc: 'Фокус на вокале: разборчивость и присутствие' },
  chorus:       { name: 'Припев',     color: '#f472b6', eq: [1, 1.5, 0.5, 0, -0.5, 0, 0.5, 1, 1.5, 1.5],      thr: -1, ratio: 1.1, width: 0.12, deess: 0.1,  tc: 0.4, desc: 'Шире, плотнее, ярче — кульминация песни' },
  buildup:      { name: 'Нарастание', color: '#fbbf24', eq: [-1.5, -1.5, -1, 0, 0, 0, 0.5, 1, 2, 3],          thr: 0,  ratio: 1,   width: -0.1, deess: 0,    tc: 0.3, desc: 'Поджимаем низ и сужаем сцену, чтобы дроп ударил сильнее' },
  drop:         { name: 'Дроп',       color: '#ff4d6d', eq: [3, 3.5, 1.5, -0.5, -1, -0.5, 0, 0.5, 1.5, 2],     thr: -2, ratio: 1.2, width: 0.2,  deess: 0,    tc: 0.05, desc: 'Максимум баса, панча и ширины' },
  breakdown:    { name: 'Брейкдаун',  color: '#a78bfa', eq: [-0.5, 0, 0.5, 0.5, 0, 0, 0, 0.5, 1.5, 2],         thr: 3,  ratio: 0.85, width: 0.2, deess: 0,    tc: 1.5, desc: 'Пространство и детали, меньше компрессии' },
  instrumental: { name: 'Инструментал', color: '#38bdf8', eq: [0.5, 0.5, 0.5, 0, -0.5, 0, 0.5, 1, 1, 1],       thr: 0,  ratio: 1,   width: 0.1,  deess: -0.2, tc: 0.8, desc: 'Инструменты на первом плане: объём и разделение' },
  outro:        { name: 'Концовка',   color: '#94a3b8', eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],                     thr: 3,  ratio: 0.9, width: 0,    deess: 0,    tc: 2.0, desc: 'Плавно отпускаем обработку' },
};

export const GENRE_KEYS = Object.keys(GENRES);
export const SECTION_KEYS = Object.keys(SECTIONS);
