import { GENRES, SECTIONS } from './profiles.js';

const TASTE = {
  bass:   [1, 1, 0.4, 0, 0, 0, 0, 0, 0, 0],
  clarity:[0, 0, 0, -0.4, -0.2, 0, 0.6, 1, 0.3, 0],
  bright: [0, 0, 0, 0, 0, 0, 0, 0.3, 0.8, 1],
};

// Личный профиль (тест «Личный профиль»): наклон баса, верха и присутствия, дБ на полосу при значении 1.
// Полосы: 32, 64, 125, 250, 500, 1к, 2к, 4к, 8к, 16к.
const PROFILE = {
  bass:     [1, 1, 0.5, 0.1, 0, 0, 0, 0, 0, 0],
  treble:   [0, 0, 0, 0, 0, 0, 0, 0.3, 0.8, 1],
  presence: [0, 0, 0, 0, 0, 0.3, 1, 0.7, 0.2, 0],
};

// Секции меняют звук совсем немного — это «дыхание» трека, а не перекраска.
const SECTION_DEPTH = 0.4;
// Секциям нельзя поднимать зону гула (125–500 Гц) и резкости (2–4 кГц).
const SECTION_UP_CAP = [Infinity, Infinity, 0.5, 0, 0, Infinity, 0.5, 0.5, Infinity, Infinity];

// «Красочность» по стилям: для акустики и классики меньше синтетических гармоник.
const ENH_GENRE = { classical: 0.4, jazz: 0.5, acoustic: 0.6, edm: 1.25, hiphop: 1.25, rnb: 1.1 };
// «Ударные» по стилям: электронике и хип-хопу нужен резкий кик, классике — почти нет.
// Полосы: 32, 64, 125, 250, 500, 1к, 2к, 4к, 8к, 16к. Зону гула (250–500) не поднимаем никогда.
// Низ здесь не поднимаем: бас и кик обрабатываются отдельными дорожками (stems), EQ на весь низ
// поднимал бы их вместе и «пердел» — здесь только воздух и чёткость.
const CHARACTER = {
  edm:    [0, 0, 0, 0, 0, 0, 0, 0.5, 1.2, 1.8],
  hiphop: [0, 0, 0, 0, 0, 0, 0.3, 0.5, 0.8, 1.2],
  rnb:    [0, 0, 0, 0, 0, 0, 0, 0.3, 0.8, 1.2],
  pop:    [0, 0, 0, 0, 0, 0, 0, 0.3, 1, 1.5],
  rock:   [0, 0, 0, 0, 0, 0, 0.3, 0.5, 0.8, 1],
  metal:  [0, 0, 0, 0, 0, 0, 0.3, 0.3, 0.5, 0.8],
};
// Сколько «баса» (громкость/протяжность/гармоники басовой дорожки) любит стиль.
const BASS_GENRE = { edm: 1.3, hiphop: 1.4, rnb: 1.1, pop: 1, rock: 0.8, metal: 0.7, lofi: 1, jazz: 0.5, acoustic: 0.5, classical: 0.3 };
const PUNCH_GENRE = { edm: 1.4, hiphop: 1.3, rock: 1.15, metal: 1.1, pop: 1.1, rnb: 1, lofi: 0.8, acoustic: 0.7, jazz: 0.6, classical: 0.4 };
const ENH_SECTION = {
  intro: { bass: 0, air: 0.05 }, verse: { bass: 0, air: -0.1 }, chorus: { bass: 0.1, air: 0.15 },
  buildup: { bass: -0.1, air: 0.2 }, drop: { bass: 0.25, air: 0.1 }, breakdown: { bass: -0.05, air: 0.15 },
  instrumental: { bass: 0.05, air: 0.1 }, outro: { bass: 0, air: 0 },
};

/**
 * Итоговые настройки обработки. Слои EQ:
 *   1) коррекция устройства — отдельная цепочка фильтров в движке (не здесь);
 *   2) автобаланс трека (balanceEq) — подтягивает тембр к эталону стиля;
 *   3) лёгкое «дыхание» по секциям;
 *   4) вкус и ручные правки пользователя (для редких случаев).
 * Громкость выравнивает автогромкость в движке, поэтому запас по уровню здесь не нужен.
 */
/**
 * need   — насколько треку не хватает плотности (0 — уже плотный мастер, 1 — очень динамичный/«тонкий»),
 *          считается на ходу по разбросу громкости; на его основе «автоплотность» сама добавляет
 *          сжатие, тепло и гармоники ровно столько, сколько нужно этому треку.
 * device — данные устройства: fLow — частота, ниже которой динамик физически почти не играет.
 */
export function computeTarget({ probs, section, progress = 0, settings, adaptive, balanceEq, need = 0.5, device = null, headroom = 12 }) {
  const comp = { thr: 0, ratio: 0, attack: 0, release: 0, mix: 0 };
  let deess = 0, width = 0, dynamic = 0, enhGenre = 0, punchGenre = 0, bassGenre = 0;

  const p = adaptive ? probs : { pop: 1 };
  let sum = 0;
  for (const k in p) sum += p[k];
  for (const k in p) {
    const w = p[k] / (sum || 1), g = GENRES[k];
    if (!g || !w) continue;
    for (const c in comp) comp[c] += w * g.comp[c];
    deess += w * g.deess;
    width += w * g.width;
    dynamic += w * g.dynamic;
    enhGenre += w * (ENH_GENRE[k] ?? 1);
    punchGenre += w * (PUNCH_GENRE[k] ?? 1);
    bassGenre += w * (BASS_GENRE[k] ?? 1);
  }
  if (!adaptive) width = 1;

  const eq = adaptive && balanceEq ? balanceEq.slice() : new Array(10).fill(0);

  // «Характер» стиля: Kilobuzz не только исправляет недостатки, но и подаёт музыку так, как её любят
  // слушать, — жирный низ и блеск для электроники и хип-хопа, мягче для рока/попа, ничего для классики.
  // Сила — от «Сочности». Подъём низа ниже предела устройства потом снимается (см. fLow).
  if (adaptive) {
    const juiceK = 0.5 + (settings.juice ?? 0.6) / 0.6 * 0.5;
    let wsum = 0;
    for (const k in p) wsum += p[k];
    for (const k in p) {
      const ch = CHARACTER[k];
      if (ch) ch.forEach((v, i) => (eq[i] += (v * p[k] / (wsum || 1)) * juiceK));
    }
  }

  let tc = 0.6;
  const enh = { bass: 0.4, air: 0.25 };
  const s = SECTIONS[section];
  if (adaptive && s) {
    let k = settings.intensity * dynamic * SECTION_DEPTH;
    if (section === 'buildup') k *= 0.3 + 0.7 * Math.min(1, progress);
    s.eq.forEach((v, i) => (eq[i] += Math.min(k * v, SECTION_UP_CAP[i])));
    comp.thr += k * s.thr;
    comp.ratio *= 1 + k * (s.ratio - 1);
    width += k * s.width * 0.5;
    deess += k * s.deess;
    const es = ENH_SECTION[section];
    enh.bass += settings.intensity * es.bass;
    enh.air += settings.intensity * es.air * (section === 'buildup' ? progress : 1);
    tc = Math.max(section === 'drop' ? 0.12 : 0.3, s.tc);
  }

  // «Не навреди»: вся автоматика вместе (автобаланс + подача стиля + секции) двигает полосу не больше
  // чем на ±2 дБ, верх — не больше +1.5. Иначе слои складываются (было +4.7 дБ на 16 кГц), автогромкость
  // убавляет всё, и тело звука проваливается — хорошо сведённый трек звучит хуже оригинала.
  // Зона шипящих 2–8 кГц («с», «ц», резкость) — автоматика её почти не поднимает (≤ +0.5 дБ): режет уши.
  for (let i = 0; i < 10; i++) eq[i] = Math.max(-2, Math.min(i >= 6 && i <= 8 ? 0.5 : i === 9 ? 1.5 : 2, eq[i]));

  for (const key of ['bass', 'clarity', 'bright']) TASTE[key].forEach((v, i) => (eq[i] += v * settings[key]));
  settings.manualEq.forEach((v, i) => (eq[i] += v));

  if (settings.loudComp) {
    const quiet = Math.max(0, 0.5 - settings.volume) / 0.5; // 0 на нормальной громкости → 1 в тишине
    eq[0] += 4 * quiet; eq[1] += 3 * quiet; eq[8] += 1 * quiet; eq[9] += 2 * quiet;
  }

  // Физический предел устройства: ниже fLow подъём EQ бесполезен (динамик не играет, только
  // искажения) — вместо этого бас передаётся гармониками, которые динамик воспроизвести может.
  const fLow = device?.fLow || 0;
  let bassLimit = settings.bassLimit ?? -9;
  if (fLow > 70) {
    [32, 64, 125, 250].forEach((f, i) => { if (f < fLow * 0.9) eq[i] = Math.min(eq[i], 0); });
    enh.bass *= 1 + Math.min(1.5, (fLow - 70) / 80);
    bassLimit -= Math.min(6, (fLow - 70) / 30);
  } else {
    // полноразмерные наушники и колонки сами играют низ — защита баса им не нужна, она только
    // плющит бас и кик. Если устройство неизвестно — срабатывает лишь на очень горячих пиках.
    bassLimit += device?.dev ? 12 : 9; // неизвестное устройство — тоже без защиты (0 дБFS): она резала бас на громких треках
  }

  for (let i = 0; i < 10; i++) eq[i] = Math.max(-15, Math.min(15, eq[i]));
  // Подъём низа — только в пределах реального запаса трека: громкий мастер (пики у 0 дБ) поднимать некуда,
  // иначе лимитеры сжимают всё вместе с басом и звук становится тише и площе (замер на фонке: бас −3 дБ).
  // часть постоянного запаса (P_HEADROOM) тоже можно отдать низу; вторая половина — восстановленным ударам
  const lowRoom = Math.max(0, headroom + 0.5 * (settings.headroom ?? 0) - 0.3);
  for (let i = 0; i < 3; i++) if (eq[i] > lowRoom) eq[i] = lowRoom;
  // личный профиль — явный вкус слушателя, поверх всего и без ограничений автоматики
  const prof = settings.profile || {};
  for (const key of Object.keys(PROFILE)) if (prof[key]) PROFILE[key].forEach((v, i) => (eq[i] += v * prof[key]));
  // «Сочность» (макро-ручка простого режима) и автоплотность
  const juice = settings.juice ?? 0.6;
  const dens = adaptive ? juice * (0.4 + 0.8 * need) : 0;
  // уже плотный мастер (электроника, современный поп) сжимать почти не нужно — иначе «плоско»
  comp.mix = Math.min(1, comp.mix * (0.55 + 0.45 * need) + 0.3 * dens);
  comp.thr -= 4 * dens;
  comp.attack = Math.max(30, comp.attack); // атака кика и малого проходит до начала сжатия
  const amount = 0.6 + 0.8 * juice;
  const enhScale = adaptive ? enhGenre || 1 : 1;
  const eB = settings.enhBass ?? 1, eP = settings.enhPunch ?? 1, eA = settings.enhAir ?? 1;
  // «Ударные»: подчёркивание атаки. В дропе и припеве чуть больше, в спокойных секциях меньше.
  const punchSec = { drop: 1.2, chorus: 1.1, breakdown: 0.7, intro: 0.85, outro: 0.85 }[section] ?? 1;

  return {
    eq,
    preamp: 0,
    comp: { ...comp, ratio: Math.max(1, comp.ratio), mix: Math.min(1, comp.mix) },
    deess: deess + settings.deessBias,
    width: Math.max(0.85, Math.min(1.25, width * settings.widthScale)),
    enhance: {
      bass: 0, // гармоники баса — теперь только на басовой дорожке (stems.harm)
      air: Math.max(0, Math.min(1, enh.air * amount * enhScale * eA)),
      warm: 0, // насыщение всего микса давало интермодуляцию («клиппинг» при той же громкости) — теперь только на дорожках
      punch: 0, // удар — теперь только на дорожке кика (stems.punch)
    },
    // дорожки: кик и бас обрабатываются по отдельности (см. StemsProcessor / native/win/stems.h)
    stems: (() => {
      // Ручки предсказуемые: громкость кика и баса — прямо в дБ (минус — тише оригинала), «жир» и «удар» — сила
      // обработки. Стиль и секция больше не умножают их (ошибка распознавания стиля давала скачки силы).
      const kickDb = Math.max(-12, Math.min(6, settings.stemKick ?? 1.5)), bassDb = Math.max(-12, Math.min(6, settings.stemBass ?? 2));
      return {
        kick: Math.min(lowRoom + 0.5, kickDb), // громче, чем позволяет запас трека, — только сжатие лимитером
        punch: Math.max(0, Math.min(1, 0.6 * eP)), // быстрая, щёлкающая атака кика
        bass: fLow > 70 ? Math.min(0, bassDb) : Math.min(lowRoom + 1, bassDb), // динамик не играет низ — только сатурация
        sustain: Math.max(0, Math.min(1, 0.6 * eB)), // «пэдовый» бас: хвост ноты держится дольше
        harm: Math.max(0, Math.min(1, 0.6 * eB)), // сатурация басовой дорожки
        // снятие маскировки на дорожке «остальное» (блок «Прозрачность»)
        tame: settings.fx?.unmask === false ? 0 : Math.max(0, Math.min(1, settings.unmask ?? 0.7)),
        recover: settings.fx?.unmask === false ? 0 : Math.max(0, Math.min(1, settings.recover ?? 0.5)),
        // восстановление ударов, придавленных лимитером при мастеринге (блок «Восстановление ударов»)
        restore: settings.fx?.restore === false ? 0 : Math.max(0, Math.min(1, settings.restore ?? 0.8)),
        // окраска: тёплое насыщение дорожки «остальное» ниже ~4 кГц (без баса и тарелок)
        color: settings.fx?.enhance === false ? 0 : Math.max(0, Math.min(1, settings.color ?? 0.4)),
        duck: Math.min(6, 3 * eP), // бас уступает место кику — кик слышен, не становясь громче
      };
    })(),
    smart: Math.min(1, (settings.smart ?? 0.6) * (0.7 + 0.6 * juice)),
    bassLimit,
    // потолок не ниже собственного пика трека: если плеер уже выдаёт пики выше 0 дБ, лимитер не должен
    // сжимать их сильнее оригинала (замер на фонке: вход +2 дБ, лимитер жал 4.7 дБ — тише и площе)
    ceiling: Math.min(3, Math.max(settings.ceiling, -headroom)),
    headroom: Math.max(0, Math.min(6, settings.headroom ?? 3)),
    drive: settings.drive,
    fx: settings.fx,
    tc,
  };
}
