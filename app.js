/* =========================================================================
 * Foodly! — рецепты, КБЖУ, список покупок, план питания, PDF.
 * Чистый JS без сборщиков. Единственная глобальная переменная — Foodly.
 * ========================================================================= */
(function (global) {
  'use strict';

  var Foodly = {};
  global.Foodly = Foodly;

  /* =======================================================================
   * Utils
   * ======================================================================= */
  var Utils = (function () {
    function uid(prefix) {
      return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }
    function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function round(n, d) { var k = Math.pow(10, d || 0); return Math.round((n + Number.EPSILON) * k) / k; }
    function fmt(n, d) {
      if (n == null || isNaN(n)) return '—';
      return Number(round(n, d == null ? 0 : d)).toLocaleString('ru-RU', { maximumFractionDigits: d == null ? 0 : d });
    }
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function norm(s) {
      return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9%,. ]+/gi, ' ').replace(/\s+/g, ' ').trim();
    }
    function parseNum(v) {
      if (typeof v === 'number') return v;
      var n = parseFloat(String(v || '').replace(',', '.').replace(/\s/g, ''));
      return isNaN(n) ? NaN : n;
    }
    function todayISO(d) {
      d = d || new Date();
      var m = d.getMonth() + 1, day = d.getDate();
      return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
    }
    function addDays(iso, n) {
      var p = iso.split('-');
      var d = new Date(+p[0], +p[1] - 1, +p[2]);
      d.setDate(d.getDate() + n);
      return todayISO(d);
    }
    function formatDate(iso, opts) {
      var p = iso.split('-');
      var d = new Date(+p[0], +p[1] - 1, +p[2]);
      return d.toLocaleDateString('ru-RU', opts || { weekday: 'short', day: 'numeric', month: 'long' });
    }
    function debounce(fn, ms) {
      var t;
      return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms); };
    }
    function plural(n, one, few, many) {
      n = Math.abs(Math.floor(n)) % 100; var n1 = n % 10;
      if (n > 10 && n < 20) return many;
      if (n1 > 1 && n1 < 5) return few;
      if (n1 === 1) return one;
      return many;
    }
    function download(filename, blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    }
    return { uid: uid, clone: clone, round: round, fmt: fmt, esc: esc, norm: norm, parseNum: parseNum,
      todayISO: todayISO, addDays: addDays, formatDate: formatDate, debounce: debounce, plural: plural, download: download };
  })();
  Foodly.Utils = Utils;
  var U = Utils;

  /* =======================================================================
   * Storage — localStorage под неймспейсом foodly:v1:*, миграции, квота
   * ======================================================================= */
  var Storage = (function () {
    var NS = 'foodly:v1:';
    var SCHEMA_VERSION = 9;
    var onError = function () {};
    var readErrors = 0;

    function isQuota(e) {
      return e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
    }
    function get(key, fallback) {
      try {
        var raw = global.localStorage.getItem(NS + key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch (e) {
        console.warn('[Foodly] storage read failed', key, e);
        readErrors++;
        return fallback;
      }
    }
    function set(key, value) {
      try {
        global.localStorage.setItem(NS + key, JSON.stringify(value));
        return true;
      } catch (e) {
        if (isQuota(e)) {
          onError('Не хватает места в хранилище браузера (~5 МБ). Удалите большие фото из рецептов или сделайте резервную копию и очистите данные.');
        } else {
          onError('Не удалось сохранить данные: ' + (e && e.message ? e.message : e));
        }
        return false;
      }
    }
    function remove(key) { try { global.localStorage.removeItem(NS + key); } catch (e) { /* ignore */ } }
    function keys() {
      var out = [];
      try {
        for (var i = 0; i < global.localStorage.length; i++) {
          var k = global.localStorage.key(i);
          if (k && k.indexOf(NS) === 0) out.push(k.slice(NS.length));
        }
      } catch (e) { /* ignore */ }
      return out;
    }

    /* Миграции: каждая функция поднимает данные с версии N до N+1. */
    var migrations = {
      // v1 -> v2: у позиций списка появились sourceRefs, у рецептов — meals[] и cuisine.
      1: function (data) {
        (data.shopping || []).forEach(function (it) {
          if (!Array.isArray(it.sourceRefs)) it.sourceRefs = [];
          if (!it.source) it.source = 'manual';
        });
        (data.recipes || []).forEach(function (r) {
          if (!Array.isArray(r.meals)) r.meals = [];
          if (typeof r.cuisine !== 'string') r.cuisine = '';
          if (!Array.isArray(r.tags)) r.tags = [];
        });
        return data;
      },
      // v2 -> v3: фото переехали в IndexedDB. Ссылки — в photoUrl, base64 переносится асинхронно (PhotoStore.migrateInline)
      2: function (data) {
        (data.recipes || []).forEach(function (r) {
          if (r.photoId === undefined) r.photoId = null;
          if (r.photoUrl === undefined) r.photoUrl = null;
          if (typeof r.photo === 'string' && /^https?:/i.test(r.photo)) { r.photoUrl = r.photo; r.photo = null; }
        });
        return data;
      },
      // v3 -> v4: демо-рецептам без фото проставляем фото по умолчанию (Wikimedia Commons)
      3: function (data) {
        (data.recipes || []).forEach(function (r) {
          if (r.photoId || r.photo || r.photoUrl) return;
          var dp = Foodly.Models && Foodly.Models.defaultPhoto(r.id);
          if (dp) { r.photoUrl = dp.photoUrl; r.photoCredit = dp.photoCredit; }
        });
        return data;
      },
      // v4 -> v5: новые фото по умолчанию. Меняем только те, что пользователь не трогал (стоит прежнее фото по умолчанию или фото нет вовсе)
      4: function (data) {
        var M = Foodly.Models; if (!M) return data;
        var legacy = {}; (M.LEGACY_DEFAULT_URLS || []).forEach(function (u) { legacy[u] = true; });
        (data.recipes || []).forEach(function (r) {
          var dp = M.defaultPhoto(r.id); if (!dp) return;
          var untouchedDefault = r.photoUrl && legacy[r.photoUrl] && !r.photo;
          var empty = !r.photoId && !r.photo && !r.photoUrl;
          if (!untouchedDefault && !empty) return;
          r.photoUrl = dp.photoUrl; r.photoCredit = dp.photoCredit;
          r.photoId = null; r.photo = null; delete r.photoCopyFailedAt;   // старая локальная копия уйдёт при очистке «сирот»
        });
        return data;
      },
      // v5 -> v6: заменили два фото по умолчанию (гречка, салат с фетой) — та же логика, что и в v4 -> v5
      5: function (data) { return migrations[4](data); },
      // v6 -> v7: черновики рецептов (draft), диеты (settings.diets добавит DB.ensureIntegrity), новые демо-рецепты для диет
      6: function (data) {
        var M = Foodly.Models;
        data.recipes = data.recipes || [];
        data.recipes.forEach(function (r) { if (r.draft === undefined) r.draft = false; });
        if (data.settings && data.settings.restrictions && !Array.isArray(data.settings.restrictions.diets)) data.settings.restrictions.diets = [];
        if (M && M.V17_RECIPE_IDS) {
          var have = {}; data.recipes.forEach(function (r) { have[r.id] = true; });
          M.buildRecipes().forEach(function (r) {
            if (M.V17_RECIPE_IDS.indexOf(r.id) >= 0 && !have[r.id]) { r.draft = false; r.createdAt = r.updatedAt = Date.now(); data.recipes.push(r); }
          });
        }
        return data;
      },
      // v7 -> v8: кето по долям калорий (жиры ≥ 60%, углеводы ≤ 10%) вместо «≤ 15 г углеводов на порцию»;
      // кето-версии пяти демо-рецептов (если пользователь их не менял) и 6 новых кето-рецептов
      7: function (data) {
        var M = Foodly.Models; if (!M) return data;
        ((data.settings && data.settings.diets) || []).forEach(function (d) { if (d.builtin && d.id === 'keto') Object.assign(d, U.clone(M.KETO_RULES)); });
        data.recipes = data.recipes || [];
        var fresh = {}; M.buildRecipes().forEach(function (r) { fresh[r.id] = r; });
        var have = {};
        data.recipes.forEach(function (r) {
          have[r.id] = true;
          var f = fresh[r.id];
          if (f && M.V18_UPDATED_IDS.indexOf(r.id) >= 0 && !r.draft && r.updatedAt === r.createdAt) {
            ['title', 'servings', 'meals', 'tags', 'cuisine', 'ingredients', 'steps'].forEach(function (k) { r[k] = U.clone(f[k]); });
          }
        });
        M.V18_RECIPE_IDS.forEach(function (id) {
          if (have[id] || !fresh[id]) return;
          var r = fresh[id]; r.draft = false; r.createdAt = r.updatedAt = Date.now(); data.recipes.push(r);
        });
        return data;
      },
      // v8 -> v9: холодильник (foodly:v1:fridge); список «всегда есть дома» (settings.pantry) добавит DB.ensureIntegrity
      8: function (data) {
        if (!Array.isArray(data.fridge)) data.fridge = [];
        return data;
      }
    };
    function migrate(data, fromVersion) {
      var v = fromVersion || 1;
      while (v < SCHEMA_VERSION) {
        if (migrations[v]) data = migrations[v](data);
        v++;
      }
      data.schemaVersion = SCHEMA_VERSION;
      return data;
    }

    return { get: get, set: set, remove: remove, keys: keys, migrate: migrate, SCHEMA_VERSION: SCHEMA_VERSION, NS: NS,
      setErrorHandler: function (fn) { onError = fn; }, readErrors: function () { return readErrors; } };
  })();
  Foodly.Storage = Storage;

  /* =======================================================================
   * Models — справочники, категории, seed-данные (продукты и рецепты)
   * ======================================================================= */
  var Models = (function () {
    var UNITS = ['г', 'кг', 'мл', 'л', 'шт', 'ст. л.', 'ч. л.', 'щепотка', 'по вкусу'];
    var MEALS = [
      { id: 'breakfast', name: 'Завтрак', emoji: '🍳' },
      { id: 'lunch', name: 'Обед', emoji: '🍲' },
      { id: 'dinner', name: 'Ужин', emoji: '🍽️' },
      { id: 'snack', name: 'Перекус', emoji: '🍎' }
    ];
    var DEFAULT_CATEGORIES = [
      { id: 'veg', name: 'Овощи и зелень' },
      { id: 'fruit', name: 'Фрукты и ягоды' },
      { id: 'bread', name: 'Хлеб и выпечка' },
      { id: 'meat', name: 'Мясо и птица' },
      { id: 'fish', name: 'Рыба и морепродукты' },
      { id: 'dairy', name: 'Молочное и яйца' },
      { id: 'grains', name: 'Крупы, макароны, бобовые' },
      { id: 'grocery', name: 'Бакалея и консервы' },
      { id: 'oils', name: 'Масла и соусы' },
      { id: 'spices', name: 'Специи и приправы' },
      { id: 'nuts', name: 'Орехи, семена, сухофрукты' },
      { id: 'frozen', name: 'Замороженное' },
      { id: 'drinks', name: 'Напитки' },
      { id: 'other', name: 'Прочее' }
    ];

    /* Справочник: [id, название, категория, ккал, Б, Ж, У, клетчатка, единицы]
       Значения на 100 г (таблицы Скурихина / USDA, углеводы — усвояемые). */
    var SP = { 'ст. л.': 17, 'ч. л.': 5 };
    var RAW_PRODUCTS = [
      // Овощи и зелень
      ['potato', 'Картофель', 'veg', 77, 2.0, 0.4, 16.3, 1.4, { 'шт': 100 }],
      ['carrot', 'Морковь', 'veg', 35, 1.3, 0.1, 6.9, 2.4, { 'шт': 75 }],
      ['onion', 'Лук репчатый', 'veg', 41, 1.4, 0.0, 8.2, 1.7, { 'шт': 90 }],
      ['red-onion', 'Лук красный', 'veg', 42, 1.4, 0.1, 9.1, 1.7, { 'шт': 90 }],
      ['garlic', 'Чеснок (зубчик)', 'veg', 149, 6.5, 0.5, 29.9, 2.1, { 'шт': 5, 'ч. л.': 4 }],
      ['tomato', 'Помидоры', 'veg', 20, 1.1, 0.2, 3.7, 1.2, { 'шт': 120 }],
      ['cherry', 'Помидоры черри', 'veg', 18, 0.9, 0.2, 3.9, 1.2, { 'шт': 15 }],
      ['cucumber', 'Огурцы', 'veg', 15, 0.8, 0.1, 2.8, 0.7, { 'шт': 120 }],
      ['bell-pepper', 'Перец болгарский', 'veg', 27, 1.3, 0.1, 5.3, 1.9, { 'шт': 150 }],
      ['cabbage', 'Капуста белокочанная', 'veg', 27, 1.8, 0.1, 4.7, 2.0, { 'шт': 1500 }],
      ['broccoli', 'Брокколи', 'veg', 34, 2.8, 0.4, 5.2, 2.6, {}],
      ['cauliflower', 'Капуста цветная', 'veg', 30, 2.5, 0.3, 4.2, 2.1, {}],
      ['zucchini', 'Кабачок', 'veg', 24, 0.6, 0.3, 4.6, 1.0, { 'шт': 250 }],
      ['eggplant', 'Баклажан', 'veg', 24, 1.2, 0.1, 4.5, 2.5, { 'шт': 250 }],
      ['beet', 'Свёкла', 'veg', 42, 1.5, 0.1, 8.8, 2.5, { 'шт': 200 }],
      ['pumpkin', 'Тыква', 'veg', 26, 1.0, 0.1, 5.5, 0.5, {}],
      ['spinach', 'Шпинат', 'veg', 23, 2.9, 0.3, 2.0, 2.2, {}],
      ['lettuce', 'Салат листовой', 'veg', 14, 1.2, 0.3, 1.3, 1.3, { 'шт': 150 }],
      ['iceberg', 'Салат айсберг', 'veg', 14, 0.9, 0.1, 1.8, 1.2, { 'шт': 500 }],
      ['dill', 'Укроп', 'veg', 40, 2.5, 0.5, 6.3, 2.8, { 'ст. л.': 4, 'ч. л.': 1.5 }],
      ['parsley', 'Петрушка', 'veg', 49, 3.7, 0.4, 7.6, 2.1, { 'ст. л.': 4, 'ч. л.': 1.5 }],
      ['green-onion', 'Лук зелёный', 'veg', 20, 1.3, 0.1, 3.2, 1.2, { 'ст. л.': 5 }],
      ['cilantro', 'Кинза', 'veg', 23, 2.1, 0.5, 1.9, 2.8, { 'ст. л.': 4 }],
      ['basil', 'Базилик свежий', 'veg', 23, 3.2, 0.6, 1.1, 1.6, { 'ст. л.': 3 }],
      ['mushrooms', 'Шампиньоны', 'veg', 27, 4.3, 1.0, 0.1, 2.6, { 'шт': 20 }],
      ['celery', 'Сельдерей (стебель)', 'veg', 16, 0.7, 0.2, 3.0, 1.6, { 'шт': 40 }],
      ['radish', 'Редис', 'veg', 20, 1.2, 0.1, 3.4, 1.6, { 'шт': 15 }],
      ['avocado', 'Авокадо', 'veg', 160, 2.0, 14.7, 1.8, 6.7, { 'шт': 150 }],
      ['ginger', 'Имбирь свежий', 'veg', 80, 1.8, 0.8, 15.8, 2.0, { 'ч. л.': 3, 'ст. л.': 9 }],
      ['sweet-potato', 'Батат', 'veg', 86, 1.6, 0.1, 17.1, 3.0, { 'шт': 200 }],
      ['leek', 'Лук-порей', 'veg', 61, 1.5, 0.3, 12.4, 1.8, { 'шт': 200 }],
      ['arugula', 'Руккола', 'veg', 25, 2.6, 0.7, 2.1, 1.6, {}],
      // Фрукты и ягоды
      ['apple', 'Яблоко', 'fruit', 47, 0.4, 0.4, 9.8, 1.8, { 'шт': 180 }],
      ['banana', 'Банан', 'fruit', 96, 1.5, 0.2, 21.8, 1.7, { 'шт': 120 }],
      ['orange', 'Апельсин', 'fruit', 43, 0.9, 0.2, 8.1, 2.2, { 'шт': 180 }],
      ['lemon', 'Лимон', 'fruit', 34, 0.9, 0.1, 3.0, 2.0, { 'шт': 100, 'ст. л.': 15, 'ч. л.': 5 }],
      ['lime', 'Лайм', 'fruit', 30, 0.7, 0.2, 7.7, 2.8, { 'шт': 60, 'ч. л.': 5 }],
      ['pear', 'Груша', 'fruit', 47, 0.4, 0.3, 10.3, 2.8, { 'шт': 170 }],
      ['strawberry', 'Клубника', 'fruit', 41, 0.8, 0.4, 7.5, 2.2, { 'шт': 15 }],
      ['blueberry', 'Черника', 'fruit', 44, 1.1, 0.4, 7.6, 3.1, { 'ст. л.': 10 }],
      ['raspberry', 'Малина', 'fruit', 46, 0.8, 0.5, 8.3, 3.7, { 'ст. л.': 10 }],
      ['kiwi', 'Киви', 'fruit', 47, 0.8, 0.4, 8.1, 3.0, { 'шт': 75 }],
      ['grapes', 'Виноград', 'fruit', 72, 0.6, 0.6, 15.4, 1.6, {}],
      ['mandarin', 'Мандарин', 'fruit', 38, 0.8, 0.2, 7.5, 1.9, { 'шт': 80 }],
      ['peach', 'Персик', 'fruit', 45, 0.9, 0.1, 9.5, 2.1, { 'шт': 150 }],
      ['plum', 'Слива', 'fruit', 49, 0.8, 0.3, 9.6, 1.5, { 'шт': 30 }],
      ['mango', 'Манго', 'fruit', 60, 0.8, 0.4, 13.4, 1.6, { 'шт': 300 }],
      ['pomegranate', 'Гранат', 'fruit', 72, 0.9, 0.0, 14.5, 4.0, { 'шт': 250, 'ст. л.': 15 }],
      // Хлеб и выпечка
      ['bread-rye', 'Хлеб ржаной', 'bread', 170, 6.6, 1.2, 33.4, 5.8, { 'шт': 30 }],
      ['bread-white', 'Хлеб пшеничный (батон)', 'bread', 262, 7.5, 2.9, 51.4, 2.7, { 'шт': 25 }],
      ['bread-wholegrain', 'Хлеб цельнозерновой', 'bread', 240, 13.0, 3.4, 34.5, 6.8, { 'шт': 35 }],
      ['pita', 'Лаваш тонкий', 'bread', 277, 7.9, 1.0, 58.0, 2.2, { 'шт': 90 }],
      ['tortilla', 'Тортилья пшеничная', 'bread', 310, 8.3, 8.0, 50.0, 3.5, { 'шт': 40 }],
      ['crispbread', 'Хлебцы цельнозерновые', 'bread', 320, 11.0, 2.5, 56.0, 14.0, { 'шт': 10 }],
      ['bun', 'Булочка для бургера', 'bread', 279, 9.0, 4.3, 49.0, 2.7, { 'шт': 60 }],
      // Мясо и птица
      ['chicken-breast', 'Куриная грудка (филе)', 'meat', 113, 23.6, 1.9, 0.4, 0, { 'шт': 250 }],
      ['chicken-thigh', 'Куриное бедро без кожи и кости', 'meat', 144, 19.0, 7.5, 0, 0, { 'шт': 100 }],
      ['chicken-drumstick', 'Куриные голени', 'meat', 161, 18.2, 9.8, 0, 0, { 'шт': 110 }],
      ['chicken-mince', 'Фарш куриный', 'meat', 143, 17.4, 8.1, 0, 0, {}],
      ['turkey-fillet', 'Филе индейки', 'meat', 114, 23.7, 1.5, 0, 0, {}],
      ['beef', 'Говядина', 'meat', 187, 18.9, 12.4, 0, 0, {}],
      ['ground-beef', 'Фарш говяжий', 'meat', 250, 17.2, 20.0, 0, 0, {}],
      ['ground-mixed', 'Фарш свино-говяжий', 'meat', 263, 17.0, 21.5, 0, 0, {}],
      ['pork', 'Свинина нежирная', 'meat', 142, 19.4, 7.1, 0, 0, {}],
      ['ham', 'Ветчина', 'meat', 147, 16.0, 9.0, 0.5, 0, { 'шт': 20 }],
      ['sausages', 'Сосиски молочные', 'meat', 261, 11.0, 23.9, 0.4, 0, { 'шт': 50 }],
      ['beef-liver', 'Печень говяжья', 'meat', 127, 17.9, 3.7, 5.3, 0, {}],
      ['bacon', 'Бекон', 'meat', 458, 13.0, 45.0, 1.4, 0, { 'шт': 15 }],
      // Рыба и морепродукты
      ['salmon', 'Лосось (сёмга)', 'fish', 208, 20.4, 13.4, 0, 0, {}],
      ['salmon-salted', 'Сёмга слабосолёная', 'fish', 202, 22.5, 12.5, 0, 0, {}],
      ['cod', 'Треска', 'fish', 78, 17.7, 0.7, 0, 0, {}],
      ['pollock', 'Минтай', 'fish', 72, 15.9, 0.9, 0, 0, {}],
      ['hake', 'Хек', 'fish', 86, 16.6, 2.2, 0, 0, {}],
      ['tuna-canned', 'Тунец консервированный в с/с', 'fish', 110, 25.0, 1.0, 0, 0, { 'шт': 185 }],
      ['shrimp', 'Креветки варёно-мороженые', 'fish', 97, 22.0, 1.0, 0, 0, {}],
      ['herring', 'Сельдь слабосолёная', 'fish', 217, 19.8, 15.4, 0, 0, {}],
      ['mackerel', 'Скумбрия', 'fish', 191, 18.0, 13.2, 0, 0, {}],
      ['crab-sticks', 'Крабовые палочки', 'fish', 88, 6.0, 1.0, 13.5, 0, { 'шт': 20 }],
      // Молочное и яйца
      ['egg', 'Яйцо куриное', 'dairy', 157, 12.7, 11.5, 0.7, 0, { 'шт': 55 }],
      ['milk', 'Молоко 2,5%', 'dairy', 52, 2.8, 2.5, 4.7, 0, { 'мл': 1.03, 'ст. л.': 18, 'ч. л.': 5 }],
      ['milk-32', 'Молоко 3,2%', 'dairy', 60, 2.9, 3.2, 4.7, 0, { 'мл': 1.03, 'ст. л.': 18 }],
      ['kefir', 'Кефир 2,5%', 'dairy', 53, 2.9, 2.5, 4.0, 0, { 'мл': 1.03, 'ст. л.': 18 }],
      ['ryazhenka', 'Ряженка 4%', 'dairy', 67, 2.8, 4.0, 4.2, 0, { 'мл': 1.03 }],
      ['cottage-cheese-5', 'Творог 5%', 'dairy', 121, 17.2, 5.0, 1.8, 0, { 'ст. л.': 20 }],
      ['cottage-cheese-0', 'Творог обезжиренный', 'dairy', 85, 18.0, 0.6, 1.8, 0, { 'ст. л.': 20 }],
      ['greek-yogurt', 'Йогурт греческий 2%', 'dairy', 68, 9.0, 2.0, 3.5, 0, { 'ст. л.': 20 }],
      ['yogurt', 'Йогурт натуральный 3,2%', 'dairy', 63, 5.0, 3.2, 3.5, 0, { 'ст. л.': 20, 'мл': 1.03 }],
      ['sour-cream', 'Сметана 15%', 'dairy', 158, 2.6, 15.0, 3.0, 0, { 'ст. л.': 20, 'ч. л.': 7 }],
      ['cream', 'Сливки 10%', 'dairy', 118, 3.0, 10.0, 4.0, 0, { 'мл': 1.01, 'ст. л.': 15 }],
      ['butter', 'Масло сливочное 82,5%', 'dairy', 748, 0.5, 82.5, 0.8, 0, { 'ст. л.': 17, 'ч. л.': 5 }],
      ['cheese', 'Сыр твёрдый', 'dairy', 358, 23.2, 29.5, 0, 0, { 'ст. л.': 7, 'шт': 20 }],
      ['mozzarella', 'Моцарелла', 'dairy', 238, 18.0, 18.0, 1.0, 0, { 'шт': 125 }],
      ['feta', 'Фета', 'dairy', 264, 14.2, 21.3, 4.1, 0, {}],
      ['parmesan', 'Пармезан', 'dairy', 388, 35.8, 25.8, 3.2, 0, { 'ст. л.': 6, 'ч. л.': 2 }],
      ['cream-cheese', 'Сыр творожный', 'dairy', 231, 7.0, 21.0, 3.5, 0, { 'ст. л.': 25, 'ч. л.': 8 }],
      ['brynza', 'Брынза', 'dairy', 260, 17.9, 20.1, 0, 0, {}],
      // Крупы, макароны, бобовые
      ['oats', 'Овсяные хлопья', 'grains', 352, 12.3, 6.2, 61.8, 6.0, { 'ст. л.': 12 }],
      ['buckwheat', 'Гречка (ядрица)', 'grains', 308, 12.6, 3.3, 57.1, 11.3, { 'ст. л.': 20 }],
      ['rice', 'Рис белый', 'grains', 344, 6.7, 0.7, 78.9, 0.4, { 'ст. л.': 20 }],
      ['brown-rice', 'Рис бурый', 'grains', 337, 7.4, 1.8, 72.9, 3.4, { 'ст. л.': 20 }],
      ['bulgur', 'Булгур', 'grains', 330, 12.3, 1.3, 57.6, 18.3, { 'ст. л.': 20 }],
      ['millet', 'Пшено', 'grains', 342, 11.5, 3.3, 66.5, 3.6, { 'ст. л.': 20 }],
      ['semolina', 'Манная крупа', 'grains', 333, 10.3, 1.0, 70.6, 3.6, { 'ст. л.': 20, 'ч. л.': 7 }],
      ['quinoa', 'Киноа', 'grains', 360, 14.1, 6.1, 57.2, 7.0, { 'ст. л.': 20 }],
      ['couscous', 'Кускус', 'grains', 360, 12.8, 0.6, 72.4, 5.0, { 'ст. л.': 20 }],
      ['pasta', 'Макароны (твёрдые сорта)', 'grains', 338, 11.0, 1.3, 70.5, 3.0, {}],
      ['spaghetti', 'Спагетти', 'grains', 341, 12.0, 1.5, 70.0, 3.0, {}],
      ['noodles', 'Лапша яичная', 'grains', 348, 11.0, 2.0, 70.0, 3.0, {}],
      ['lentils-red', 'Чечевица красная', 'grains', 345, 24.0, 2.0, 52.0, 10.8, { 'ст. л.': 20 }],
      ['chickpeas', 'Нут сухой', 'grains', 335, 19.3, 6.0, 45.0, 12.2, { 'ст. л.': 20 }],
      ['beans-canned', 'Фасоль красная консервированная', 'grains', 92, 6.7, 0.4, 12.5, 6.0, { 'шт': 240 }],
      ['flour', 'Мука пшеничная', 'grains', 331, 10.3, 1.1, 69.9, 3.5, { 'ст. л.': 20, 'ч. л.': 8 }],
      ['granola', 'Гранола', 'grains', 447, 10.0, 17.0, 60.0, 7.0, { 'ст. л.': 10 }],
      // Бакалея и консервы
      ['sugar', 'Сахар', 'grocery', 399, 0, 0, 99.8, 0, { 'ст. л.': 25, 'ч. л.': 8 }],
      ['honey', 'Мёд', 'grocery', 324, 0.8, 0, 80.3, 0, { 'ст. л.': 30, 'ч. л.': 10 }],
      ['vanilla-sugar', 'Ванильный сахар', 'grocery', 398, 0, 0, 99.5, 0, { 'ч. л.': 4, 'шт': 10 }],
      ['baking-powder', 'Разрыхлитель', 'grocery', 53, 0, 0, 13.0, 0, { 'ч. л.': 5 }],
      ['cocoa', 'Какао-порошок', 'grocery', 289, 24.2, 15.0, 10.2, 33.0, { 'ст. л.': 8, 'ч. л.': 3 }],
      ['dark-chocolate', 'Шоколад тёмный 70%', 'grocery', 546, 7.8, 42.6, 33.0, 11.0, { 'шт': 100 }],
      ['jam', 'Варенье (джем)', 'grocery', 265, 0.4, 0.1, 65.0, 1.0, { 'ст. л.': 20, 'ч. л.': 7 }],
      ['peanut-butter', 'Арахисовая паста', 'grocery', 590, 25.0, 50.0, 12.0, 6.0, { 'ст. л.': 16, 'ч. л.': 5 }],
      ['canned-tomatoes', 'Томаты в собственном соку', 'grocery', 20, 1.0, 0.1, 3.5, 1.0, { 'шт': 400 }],
      ['tomato-paste', 'Томатная паста', 'grocery', 82, 4.3, 0.5, 14.9, 4.1, { 'ст. л.': 25, 'ч. л.': 8 }],
      ['corn-canned', 'Кукуруза консервированная', 'grocery', 86, 3.0, 1.2, 15.0, 2.2, { 'ст. л.': 15, 'шт': 340 }],
      ['peas-canned', 'Горошек консервированный', 'grocery', 50, 3.1, 0.2, 7.0, 3.6, { 'ст. л.': 15, 'шт': 400 }],
      ['olives', 'Оливки', 'grocery', 145, 1.0, 15.3, 0.5, 3.3, { 'шт': 4 }],
      ['pickles', 'Огурцы маринованные', 'grocery', 11, 0.8, 0.1, 1.7, 1.0, { 'шт': 60 }],
      ['coconut-milk', 'Кокосовое молоко', 'grocery', 200, 2.0, 21.0, 2.8, 0, { 'мл': 1.0 }],
      ['tofu', 'Тофу', 'grocery', 76, 8.1, 4.8, 1.9, 0.3, {}],
      ['breadcrumbs', 'Панировочные сухари', 'grocery', 343, 9.7, 1.9, 71.7, 4.5, { 'ст. л.': 10 }],
      ['starch', 'Крахмал кукурузный', 'grocery', 343, 1.0, 0.6, 85.0, 0.9, { 'ст. л.': 10, 'ч. л.': 3 }],
      // Масла и соусы
      ['sunflower-oil', 'Масло подсолнечное', 'oils', 899, 0, 99.9, 0, 0, { 'ст. л.': 17, 'ч. л.': 5, 'мл': 0.92 }],
      ['olive-oil', 'Масло оливковое', 'oils', 898, 0, 99.8, 0, 0, { 'ст. л.': 17, 'ч. л.': 5, 'мл': 0.91 }],
      ['mayo', 'Майонез 67%', 'oils', 620, 0.3, 67.0, 3.9, 0, { 'ст. л.': 15, 'ч. л.': 5 }],
      ['ketchup', 'Кетчуп', 'oils', 99, 1.2, 0.2, 23.0, 0.3, { 'ст. л.': 17, 'ч. л.': 6 }],
      ['soy-sauce', 'Соевый соус', 'oils', 51, 6.0, 0, 6.6, 0, { 'ст. л.': 18, 'ч. л.': 6, 'мл': 1.15 }],
      ['mustard', 'Горчица', 'oils', 144, 5.7, 6.4, 16.0, 2.0, { 'ст. л.': 20, 'ч. л.': 7 }],
      ['vinegar', 'Уксус яблочный', 'oils', 21, 0, 0, 0.9, 0, { 'ст. л.': 15, 'ч. л.': 5, 'мл': 1.0 }],
      ['pesto', 'Соус песто', 'oils', 450, 5.0, 45.0, 6.0, 1.5, { 'ст. л.': 15, 'ч. л.': 5 }],
      ['tahini', 'Тахини (кунжутная паста)', 'oils', 595, 17.0, 53.8, 11.0, 9.3, { 'ст. л.': 15, 'ч. л.': 5 }],
      // Специи и приправы
      ['salt', 'Соль', 'spices', 0, 0, 0, 0, 0, { 'ч. л.': 7, 'ст. л.': 22 }],
      ['black-pepper', 'Перец чёрный молотый', 'spices', 251, 10.4, 3.3, 38.7, 25.3, { 'ч. л.': 2.5 }],
      ['paprika', 'Паприка молотая', 'spices', 282, 14.1, 12.9, 19.0, 34.9, { 'ч. л.': 2.5 }],
      ['cinnamon', 'Корица молотая', 'spices', 247, 4.0, 1.2, 27.5, 53.0, { 'ч. л.': 2.6 }],
      ['bay-leaf', 'Лавровый лист', 'spices', 313, 7.6, 8.4, 48.7, 26.3, { 'шт': 0.2 }],
      ['oregano', 'Орегано сушёный', 'spices', 265, 9.0, 4.3, 26.0, 42.5, { 'ч. л.': 1 }],
      ['cumin', 'Зира (кумин)', 'spices', 375, 17.8, 22.3, 33.7, 10.5, { 'ч. л.': 2 }],
      ['curry', 'Карри (порошок)', 'spices', 325, 14.3, 14.0, 25.0, 33.2, { 'ч. л.': 2 }],
      ['turmeric', 'Куркума', 'spices', 312, 9.7, 3.3, 45.0, 22.7, { 'ч. л.': 3 }],
      ['herbs', 'Прованские травы', 'spices', 270, 9.0, 5.0, 30.0, 40.0, { 'ч. л.': 1 }],
      ['chili', 'Перец чили хлопья', 'spices', 314, 12.0, 17.0, 24.0, 27.0, { 'ч. л.': 2 }],
      ['nutmeg', 'Мускатный орех молотый', 'spices', 525, 5.8, 36.3, 28.5, 20.8, { 'ч. л.': 2 }],
      // Орехи, семена, сухофрукты
      ['walnuts', 'Грецкие орехи', 'nuts', 654, 15.2, 65.2, 7.0, 6.7, { 'ст. л.': 8, 'шт': 5 }],
      ['almonds', 'Миндаль', 'nuts', 579, 21.2, 49.9, 9.7, 12.5, { 'ст. л.': 10, 'шт': 1.2 }],
      ['cashews', 'Кешью', 'nuts', 553, 18.2, 43.9, 27.0, 3.3, { 'ст. л.': 10 }],
      ['hazelnuts', 'Фундук', 'nuts', 628, 15.0, 60.8, 7.0, 9.7, { 'ст. л.': 10 }],
      ['peanuts', 'Арахис', 'nuts', 567, 25.8, 49.2, 7.6, 8.5, { 'ст. л.': 10 }],
      ['sunflower-seeds', 'Семечки подсолнечника', 'nuts', 584, 20.8, 51.5, 11.4, 8.6, { 'ст. л.': 9 }],
      ['pumpkin-seeds', 'Тыквенные семечки', 'nuts', 559, 30.2, 49.1, 4.7, 6.0, { 'ст. л.': 9 }],
      ['chia', 'Семена чиа', 'nuts', 486, 16.5, 30.7, 7.7, 34.4, { 'ст. л.': 12, 'ч. л.': 4 }],
      ['flax', 'Семена льна', 'nuts', 534, 18.3, 42.2, 1.6, 27.3, { 'ст. л.': 10, 'ч. л.': 3.5 }],
      ['sesame', 'Кунжут', 'nuts', 573, 17.7, 49.7, 12.0, 11.8, { 'ст. л.': 9, 'ч. л.': 3 }],
      ['raisins', 'Изюм', 'nuts', 299, 3.1, 0.5, 71.2, 3.7, { 'ст. л.': 15 }],
      ['dried-apricots', 'Курага', 'nuts', 241, 3.4, 0.5, 51.0, 7.3, { 'шт': 8 }],
      ['prunes', 'Чернослив', 'nuts', 240, 2.2, 0.4, 57.4, 7.1, { 'шт': 8 }],
      ['dates', 'Финики', 'nuts', 282, 2.5, 0.4, 67.0, 8.0, { 'шт': 7 }],
      ['coconut-flakes', 'Кокосовая стружка', 'nuts', 660, 6.9, 64.5, 7.4, 16.3, { 'ст. л.': 6 }],
      // Замороженное
      ['peas-frozen', 'Горошек зелёный замороженный', 'frozen', 73, 5.0, 0.2, 9.0, 5.0, { 'ст. л.': 15 }],
      ['green-beans', 'Фасоль стручковая замороженная', 'frozen', 31, 1.8, 0.2, 4.3, 2.7, {}],
      ['berries-frozen', 'Ягоды замороженные (микс)', 'frozen', 45, 0.8, 0.4, 8.0, 3.5, { 'ст. л.': 12 }],
      ['veg-mix', 'Овощная смесь замороженная', 'frozen', 42, 2.2, 0.3, 6.0, 3.0, {}],
      ['broccoli-frozen', 'Брокколи замороженная', 'frozen', 28, 3.0, 0.3, 2.0, 3.0, {}],
      // Напитки
      ['water', 'Вода', 'drinks', 0, 0, 0, 0, 0, { 'мл': 1.0 }],
      ['orange-juice', 'Сок апельсиновый', 'drinks', 45, 0.7, 0.2, 10.4, 0.2, { 'мл': 1.04 }],
      ['oat-milk', 'Овсяное молоко', 'drinks', 46, 1.0, 1.5, 7.0, 0.8, { 'мл': 1.03 }],
      ['broth', 'Бульон овощной', 'drinks', 6, 0.2, 0.1, 1.0, 0, { 'мл': 1.0 }],
      ['coffee', 'Кофе молотый', 'drinks', 2, 0.1, 0, 0.3, 0, { 'ч. л.': 5 }],
      ['tea', 'Чай чёрный', 'drinks', 1, 0, 0, 0.3, 0, { 'ч. л.': 2 }]
    ];

    function buildProducts() {
      return RAW_PRODUCTS.map(function (r) {
        var units = {};
        Object.keys(r[8] || {}).forEach(function (k) { units[k] = r[8][k]; });
        return {
          id: r[0], name: r[1], category: r[2],
          per100: { kcal: r[3], protein: r[4], fat: r[5], carbs: r[6], fiber: r[7] },
          units: units, isCustom: false
        };
      });
    }
    void SP;

    /* Рецепты: ингредиенты [productId, количество, единица] */
    var RAW_RECIPES = [
      // ---- Завтраки ----
      { id: 'r-oatmeal', title: 'Овсяная каша с бананом и орехами', servings: 2, meals: ['breakfast'], cuisine: 'Домашняя', tags: ['каша', 'быстро'],
        ing: [['oats', 100, 'г'], ['milk', 400, 'мл'], ['banana', 1, 'шт'], ['walnuts', 20, 'г'], ['honey', 1, 'ст. л.'], ['salt', 1, 'щепотка']],
        steps: ['Доведите молоко до кипения, добавьте щепотку соли.', 'Всыпьте овсяные хлопья и варите 5–7 минут на слабом огне, помешивая.', 'Нарежьте банан кружками, орехи слегка порубите.', 'Разложите кашу по тарелкам, добавьте банан, орехи и полейте мёдом.'] },
      { id: 'r-syrniki', title: 'Сырники со сметаной', servings: 3, meals: ['breakfast', 'snack'], cuisine: 'Русская', tags: ['творог'],
        ing: [['cottage-cheese-5', 400, 'г'], ['egg', 1, 'шт'], ['flour', 2, 'ст. л.'], ['sugar', 1, 'ст. л.'], ['vanilla-sugar', 1, 'ч. л.'], ['sunflower-oil', 1, 'ст. л.'], ['sour-cream', 4, 'ст. л.']],
        steps: ['Разомните творог вилкой, добавьте яйцо, сахар и ванильный сахар.', 'Вмешайте муку — масса должна держать форму.', 'Сформируйте 9–10 сырников, обваляйте в муке.', 'Обжарьте на разогретом масле по 3 минуты с каждой стороны на среднем огне.', 'Подавайте со сметаной.'] },
      { id: 'r-omelet', title: 'Омлет с овощами и сыром', servings: 2, meals: ['breakfast'], cuisine: 'Домашняя', tags: ['яйца', 'быстро'],
        ing: [['egg', 4, 'шт'], ['milk', 100, 'мл'], ['tomato', 1, 'шт'], ['bell-pepper', 0.5, 'шт'], ['cheese', 30, 'г'], ['butter', 10, 'г'], ['salt', 0, 'по вкусу']],
        steps: ['Нарежьте помидор и перец небольшими кубиками.', 'Взбейте яйца с молоком и солью.', 'Растопите масло на сковороде, обжарьте перец 2 минуты, добавьте помидор.', 'Влейте яйца, накройте крышкой и готовьте 5–6 минут на слабом огне.', 'Посыпьте тёртым сыром и дайте ему расплавиться.'] },
      { id: 'r-avocado-toast', title: 'Тосты с авокадо и яйцом', servings: 2, meals: ['breakfast', 'snack'], cuisine: 'Европейская', tags: ['быстро'],
        ing: [['bread-wholegrain', 4, 'шт'], ['avocado', 1, 'шт'], ['egg', 2, 'шт'], ['lemon', 1, 'ч. л.'], ['salt', 0, 'по вкусу'], ['black-pepper', 1, 'щепотка']],
        steps: ['Подсушите хлеб в тостере или на сухой сковороде.', 'Разомните мякоть авокадо с лимонным соком, солью и перцем.', 'Сварите яйца пашот или всмятку (6 минут).', 'Намажьте авокадо на тосты, сверху выложите яйцо.'] },
      { id: 'r-yogurt-granola', title: 'Йогурт с гранолой и ягодами', servings: 1, meals: ['breakfast', 'snack'], cuisine: 'Европейская', tags: ['без готовки', 'быстро'],
        ing: [['greek-yogurt', 200, 'г'], ['granola', 40, 'г'], ['berries-frozen', 80, 'г'], ['honey', 1, 'ч. л.']],
        steps: ['Разморозьте ягоды (или возьмите свежие).', 'Выложите слоями в стакан йогурт, гранолу и ягоды.', 'Полейте мёдом и подавайте сразу, чтобы гранола осталась хрустящей.'] },
      { id: 'r-salmon-toast', title: 'Тосты с творожным сыром и сёмгой', servings: 2, meals: ['breakfast', 'snack'], cuisine: 'Европейская', tags: ['рыба', 'быстро'],
        ing: [['bread-wholegrain', 4, 'шт'], ['cream-cheese', 60, 'г'], ['salmon-salted', 100, 'г'], ['cucumber', 0.5, 'шт'], ['dill', 1, 'ст. л.']],
        steps: ['Подсушите хлеб.', 'Намажьте творожный сыр.', 'Выложите тонкие ломтики огурца и сёмги.', 'Посыпьте рубленым укропом.'] },
      // ---- Обеды ----
      { id: 'r-borsch', title: 'Борщ с говядиной', servings: 6, meals: ['lunch'], cuisine: 'Русская', tags: ['суп'],
        ing: [['beef', 500, 'г'], ['beet', 2, 'шт'], ['cabbage', 300, 'г'], ['potato', 3, 'шт'], ['carrot', 1, 'шт'], ['onion', 1, 'шт'], ['tomato-paste', 2, 'ст. л.'], ['sunflower-oil', 2, 'ст. л.'], ['garlic', 2, 'шт'], ['water', 2.5, 'л'], ['sour-cream', 6, 'ст. л.'], ['bay-leaf', 2, 'шт'], ['salt', 0, 'по вкусу']],
        steps: ['Залейте говядину водой, доведите до кипения, снимите пену и варите 1,5 часа.', 'Натрите свёклу и морковь, нарежьте лук. Обжарьте на масле 5 минут, добавьте томатную пасту и тушите ещё 5 минут.', 'Достаньте мясо, нарежьте кусочками и верните в бульон.', 'Добавьте картофель кубиками, через 10 минут — нашинкованную капусту.', 'Через 10 минут добавьте зажарку, лавровый лист, соль. Варите 10 минут.', 'Выключите огонь, добавьте чеснок и дайте настояться 20 минут. Подавайте со сметаной.'] },
      { id: 'r-plov', title: 'Плов с курицей', servings: 4, meals: ['lunch', 'dinner'], cuisine: 'Узбекская', tags: ['курица'],
        ing: [['chicken-thigh', 500, 'г'], ['rice', 300, 'г'], ['carrot', 2, 'шт'], ['onion', 2, 'шт'], ['sunflower-oil', 3, 'ст. л.'], ['garlic', 8, 'шт'], ['cumin', 1, 'ч. л.'], ['water', 600, 'мл'], ['salt', 0, 'по вкусу']],
        steps: ['Промойте рис до прозрачной воды.', 'Обжарьте курицу кусочками на масле в казане до корочки.', 'Добавьте лук полукольцами, затем морковь соломкой, жарьте 7 минут.', 'Посолите, добавьте зиру, разровняйте и выложите рис ровным слоем.', 'Залейте горячей водой на 1,5 см выше риса, воткните зубчики чеснока.', 'Готовьте под крышкой на слабом огне 25 минут, затем дайте постоять 10 минут.'] },
      { id: 'r-pasta-navy', title: 'Макароны по-флотски', servings: 4, meals: ['lunch', 'dinner'], cuisine: 'Русская', tags: ['фарш', 'быстро'],
        ing: [['pasta', 300, 'г'], ['ground-beef', 400, 'г'], ['onion', 1, 'шт'], ['sunflower-oil', 1, 'ст. л.'], ['salt', 0, 'по вкусу'], ['black-pepper', 1, 'щепотка']],
        steps: ['Отварите макароны до состояния аль денте.', 'Обжарьте лук на масле до мягкости.', 'Добавьте фарш и жарьте, разбивая комочки, 10 минут. Посолите и поперчите.', 'Смешайте фарш с макаронами и прогрейте 2 минуты.'] },
      { id: 'r-buckwheat-mush', title: 'Гречка с грибами и луком', servings: 4, meals: ['lunch', 'dinner'], cuisine: 'Русская', tags: ['постное'],
        ing: [['buckwheat', 250, 'г'], ['mushrooms', 400, 'г'], ['onion', 2, 'шт'], ['butter', 20, 'г'], ['sunflower-oil', 1, 'ст. л.'], ['water', 500, 'мл'], ['salt', 0, 'по вкусу']],
        steps: ['Промойте гречку, залейте кипятком, посолите и варите под крышкой 15 минут.', 'Обжарьте лук на масле 5 минут, добавьте нарезанные грибы и жарьте до испарения жидкости.', 'Смешайте гречку с грибами, добавьте сливочное масло.'] },
      { id: 'r-lentil-soup', title: 'Суп из красной чечевицы', servings: 4, meals: ['lunch'], cuisine: 'Турецкая', tags: ['суп', 'постное'],
        ing: [['lentils-red', 200, 'г'], ['carrot', 1, 'шт'], ['onion', 1, 'шт'], ['potato', 2, 'шт'], ['tomato-paste', 1, 'ст. л.'], ['olive-oil', 2, 'ст. л.'], ['cumin', 1, 'ч. л.'], ['water', 1.5, 'л'], ['lemon', 0.5, 'шт'], ['salt', 0, 'по вкусу']],
        steps: ['Обжарьте лук и морковь на оливковом масле 5 минут, добавьте томатную пасту и зиру.', 'Добавьте промытую чечевицу, картофель кубиками и воду.', 'Варите 20 минут до мягкости, посолите.', 'Пюрируйте блендером и подавайте с долькой лимона.'] },
      { id: 'r-caesar', title: 'Салат «Цезарь» с курицей', servings: 2, meals: ['lunch', 'dinner'], cuisine: 'Европейская', tags: ['салат', 'курица'],
        ing: [['chicken-breast', 250, 'г'], ['lettuce', 150, 'г'], ['cherry', 8, 'шт'], ['parmesan', 20, 'г'], ['bread-white', 2, 'шт'], ['olive-oil', 1, 'ст. л.'], ['mayo', 2, 'ст. л.'], ['garlic', 1, 'шт'], ['lemon', 1, 'ч. л.'], ['salt', 0, 'по вкусу']],
        steps: ['Обжарьте куриное филе на половине масла по 6 минут с каждой стороны, нарежьте.', 'Нарежьте хлеб кубиками и подсушите на оставшемся масле с чесноком.', 'Смешайте майонез с лимонным соком и тёртым чесноком — получится соус.', 'Порвите салат руками, добавьте черри, курицу, сухарики, соус и пармезан.'] },
      // ---- Ужины ----
      { id: 'r-salmon-broccoli', title: 'Запечённый лосось с брокколи', servings: 2, meals: ['dinner'], cuisine: 'Европейская', tags: ['рыба', 'духовка'],
        ing: [['salmon', 300, 'г'], ['broccoli', 400, 'г'], ['olive-oil', 1, 'ст. л.'], ['lemon', 0.5, 'шт'], ['salt', 0, 'по вкусу'], ['black-pepper', 1, 'щепотка']],
        steps: ['Разогрейте духовку до 200 °C.', 'Разберите брокколи на соцветия, сбрызните маслом, посолите.', 'Выложите лосось и брокколи на противень, полейте лимонным соком, поперчите.', 'Запекайте 15–18 минут.'] },
      { id: 'r-cutlets-mash', title: 'Куриные котлеты с картофельным пюре', servings: 4, meals: ['dinner', 'lunch'], cuisine: 'Русская', tags: ['курица'],
        ing: [['chicken-breast', 600, 'г'], ['onion', 1, 'шт'], ['egg', 1, 'шт'], ['bread-white', 1, 'шт'], ['sunflower-oil', 2, 'ст. л.'], ['potato', 8, 'шт'], ['milk', 150, 'мл'], ['butter', 30, 'г'], ['salt', 0, 'по вкусу']],
        steps: ['Прокрутите филе с луком через мясорубку, добавьте яйцо, размоченный хлеб и соль.', 'Сформируйте котлеты мокрыми руками.', 'Обжарьте на масле по 3 минуты с каждой стороны, затем тушите под крышкой 10 минут.', 'Отварите картофель, слейте воду, разомните с горячим молоком и сливочным маслом.'] },
      { id: 'r-turkey-ragout', title: 'Овощное рагу с индейкой', servings: 4, meals: ['dinner', 'lunch'], cuisine: 'Домашняя', tags: ['овощи'],
        ing: [['turkey-fillet', 500, 'г'], ['zucchini', 1, 'шт'], ['eggplant', 1, 'шт'], ['bell-pepper', 2, 'шт'], ['tomato', 2, 'шт'], ['onion', 1, 'шт'], ['carrot', 1, 'шт'], ['olive-oil', 2, 'ст. л.'], ['garlic', 2, 'шт'], ['salt', 0, 'по вкусу']],
        steps: ['Нарежьте индейку кубиками и обжарьте на масле 7 минут.', 'Добавьте лук и морковь, через 5 минут — баклажан и перец.', 'Добавьте кабачок, помидоры и чеснок, посолите.', 'Тушите под крышкой 20 минут, помешивая.'] },
      { id: 'r-cod-rice', title: 'Треска в сметане с рисом', servings: 2, meals: ['dinner', 'lunch'], cuisine: 'Домашняя', tags: ['рыба'],
        ing: [['cod', 400, 'г'], ['rice', 150, 'г'], ['carrot', 1, 'шт'], ['onion', 1, 'шт'], ['sour-cream', 3, 'ст. л.'], ['sunflower-oil', 1, 'ст. л.'], ['salt', 0, 'по вкусу']],
        steps: ['Отварите рис в подсоленной воде.', 'Обжарьте лук и морковь на масле 5 минут.', 'Выложите сверху кусочки трески, посолите, добавьте сметану и 50 мл воды.', 'Тушите под крышкой 12–15 минут. Подавайте с рисом.'] },
      { id: 'r-bolognese', title: 'Спагетти болоньезе', servings: 4, meals: ['dinner', 'lunch'], cuisine: 'Итальянская', tags: ['паста', 'фарш'],
        ing: [['spaghetti', 320, 'г'], ['ground-mixed', 300, 'г'], ['canned-tomatoes', 400, 'г'], ['onion', 1, 'шт'], ['carrot', 1, 'шт'], ['garlic', 2, 'шт'], ['olive-oil', 1, 'ст. л.'], ['parmesan', 30, 'г'], ['oregano', 1, 'ч. л.'], ['salt', 0, 'по вкусу']],
        steps: ['Мелко нарежьте лук, морковь и чеснок, обжарьте на масле 5 минут.', 'Добавьте фарш, жарьте 8 минут, разбивая комочки.', 'Добавьте томаты, орегано и соль, тушите 20 минут.', 'Отварите спагетти, смешайте с соусом, посыпьте тёртым пармезаном.'] },
      { id: 'r-shakshuka', title: 'Шакшука', servings: 2, meals: ['dinner', 'breakfast'], cuisine: 'Ближневосточная', tags: ['яйца'],
        ing: [['egg', 4, 'шт'], ['canned-tomatoes', 400, 'г'], ['bell-pepper', 1, 'шт'], ['onion', 1, 'шт'], ['olive-oil', 1, 'ст. л.'], ['cumin', 0.5, 'ч. л.'], ['paprika', 1, 'ч. л.'], ['bread-wholegrain', 2, 'шт'], ['salt', 0, 'по вкусу']],
        steps: ['Обжарьте лук и перец на масле 6 минут.', 'Добавьте специи и томаты, тушите 10 минут, посолите.', 'Сделайте в соусе 4 углубления и вбейте яйца.', 'Готовьте под крышкой 5–7 минут. Подавайте с хлебом.'] },
      // ---- Перекусы ----
      { id: 'r-smoothie', title: 'Смузи банан-ягоды', servings: 2, meals: ['snack', 'breakfast'], cuisine: 'Европейская', tags: ['напиток', 'без готовки'],
        ing: [['banana', 1, 'шт'], ['berries-frozen', 150, 'г'], ['kefir', 300, 'мл'], ['oats', 2, 'ст. л.']],
        steps: ['Сложите все ингредиенты в блендер.', 'Взбейте до однородности 1 минуту.', 'Разлейте по стаканам и подавайте сразу.'] },
      { id: 'r-cottage-berries', title: 'Творог с ягодами и мёдом', servings: 1, meals: ['snack', 'breakfast'], cuisine: 'Домашняя', tags: ['творог', 'без готовки'],
        ing: [['cottage-cheese-5', 150, 'г'], ['berries-frozen', 50, 'г'], ['honey', 1, 'ч. л.']],
        steps: ['Выложите творог в миску.', 'Добавьте ягоды и полейте мёдом.'] },
      { id: 'r-hummus', title: 'Хумус с овощными палочками', servings: 4, meals: ['snack'], cuisine: 'Ближневосточная', tags: ['постное'],
        ing: [['chickpeas', 200, 'г'], ['tahini', 2, 'ст. л.'], ['olive-oil', 2, 'ст. л.'], ['lemon', 1, 'шт'], ['garlic', 1, 'шт'], ['cumin', 0.5, 'ч. л.'], ['carrot', 2, 'шт'], ['cucumber', 2, 'шт'], ['salt', 0, 'по вкусу']],
        steps: ['Замочите нут на ночь, затем варите 1,5 часа до мягкости.', 'Пробейте нут блендером с тахини, маслом, соком лимона, чесноком, зирой и 50 мл воды от варки.', 'Нарежьте морковь и огурцы брусочками.', 'Подавайте хумус с овощами.'] },
      { id: 'r-apple-pb', title: 'Яблоко с арахисовой пастой', servings: 1, meals: ['snack'], cuisine: 'Домашняя', tags: ['без готовки', 'быстро'],
        ing: [['apple', 1, 'шт'], ['peanut-butter', 1, 'ст. л.']],
        steps: ['Нарежьте яблоко дольками, удалите сердцевину.', 'Подавайте с арахисовой пастой.'] },
      { id: 'r-energy-balls', title: 'Шарики из фиников и миндаля', servings: 8, meals: ['snack'], cuisine: 'Домашняя', tags: ['сладкое', 'без выпечки'],
        ing: [['dates', 12, 'шт'], ['almonds', 80, 'г'], ['cocoa', 1, 'ст. л.'], ['chia', 1, 'ст. л.'], ['coconut-flakes', 2, 'ст. л.']],
        steps: ['Удалите косточки из фиников.', 'Измельчите миндаль в блендере, добавьте финики, какао и чиа, пробейте до липкой массы.', 'Скатайте 8 шариков и обваляйте в кокосовой стружке.', 'Уберите в холодильник на 30 минут.'] },
      { id: 'r-greek-salad', title: 'Овощной салат с фетой', servings: 2, meals: ['snack', 'dinner'], cuisine: 'Греческая', tags: ['салат', 'без готовки'],
        ing: [['cucumber', 2, 'шт'], ['tomato', 2, 'шт'], ['bell-pepper', 1, 'шт'], ['red-onion', 0.5, 'шт'], ['feta', 100, 'г'], ['olives', 10, 'шт'], ['olive-oil', 1, 'ст. л.'], ['oregano', 0.5, 'ч. л.']],
        steps: ['Крупно нарежьте огурцы, помидоры и перец.', 'Нарежьте лук тонкими полукольцами.', 'Выложите овощи, оливки и кубики феты в миску.', 'Полейте маслом и посыпьте орегано.'] },
      // ---- Добавлены в v1.7 (для диет: кето, веганская, безглютеновая) ----
      { id: 'r-keto-eggs', title: 'Яичница с беконом и авокадо', servings: 1, meals: ['breakfast'], cuisine: 'Европейская', tags: ['яйца', 'быстро'],
        ing: [['egg', 3, 'шт'], ['bacon', 2, 'шт'], ['avocado', 0.5, 'шт'], ['butter', 5, 'г'], ['salt', 0, 'по вкусу'], ['black-pepper', 1, 'щепотка']],
        steps: ['Обжарьте бекон на сухой сковороде до хруста, переложите на тарелку.', 'Растопите сливочное масло в той же сковороде и разбейте яйца.', 'Жарьте 3–4 минуты, посолите и поперчите.', 'Подавайте с беконом и ломтиками авокадо.'] },
      { id: 'r-tuna-salad', title: 'Салат с тунцом, авокадо и яйцом', servings: 2, meals: ['lunch', 'dinner'], cuisine: 'Домашняя', tags: ['салат', 'рыба', 'быстро'],
        ing: [['tuna-canned', 1, 'шт'], ['egg', 2, 'шт'], ['avocado', 1, 'шт'], ['cucumber', 1, 'шт'], ['lettuce', 60, 'г'], ['olive-oil', 2, 'ст. л.'], ['mayo', 1, 'ст. л.'], ['salt', 0, 'по вкусу']],
        steps: ['Сварите яйца вкрутую (9 минут), остудите и нарежьте.', 'Нарежьте огурец и авокадо, порвите листья салата.', 'Слейте жидкость с тунца и разберите его вилкой.', 'Смешайте всё, заправьте оливковым маслом и майонезом, посолите.'] },
      { id: 'r-chicken-thighs-veg', title: 'Куриные бёдра с кабачком под сыром', servings: 3, meals: ['dinner', 'lunch'], cuisine: 'Домашняя', tags: ['курица', 'духовка'],
        ing: [['chicken-thigh', 600, 'г'], ['zucchini', 1, 'шт'], ['bell-pepper', 0.5, 'шт'], ['olive-oil', 4, 'ст. л.'], ['cheese', 60, 'г'], ['garlic', 2, 'шт'], ['paprika', 1, 'ч. л.'], ['salt', 0, 'по вкусу']],
        steps: ['Разогрейте духовку до 200 °C.', 'Натрите бёдра паприкой, солью и рубленым чесноком.', 'Нарежьте кабачок и перец крупными кусками, смешайте с маслом.', 'Выложите всё на противень и запекайте 25 минут.', 'Посыпьте тёртым сыром и запекайте ещё 7–10 минут.'] },
      { id: 'r-cheese-nuts', title: 'Сыр с грецкими орехами', servings: 1, meals: ['snack'], cuisine: 'Домашняя', tags: ['без готовки', 'быстро'],
        ing: [['cheese', 40, 'г'], ['walnuts', 15, 'г']], steps: ['Нарежьте сыр кубиками.', 'Подавайте с грецкими орехами.'] },
      { id: 'r-chickpea-curry', title: 'Карри из нута со шпинатом и рисом', servings: 4, meals: ['lunch', 'dinner'], cuisine: 'Индийская', tags: ['постное', 'бобовые'],
        ing: [['chickpeas', 200, 'г'], ['coconut-milk', 200, 'мл'], ['canned-tomatoes', 400, 'г'], ['onion', 1, 'шт'], ['garlic', 2, 'шт'], ['curry', 2, 'ч. л.'], ['spinach', 100, 'г'], ['olive-oil', 1, 'ст. л.'], ['rice', 200, 'г'], ['salt', 0, 'по вкусу']],
        steps: ['Замочите нут на ночь и отварите до мягкости (около 1,5 часа).', 'Отварите рис.', 'Обжарьте лук и чеснок на масле, добавьте карри и прогрейте 1 минуту.', 'Добавьте томаты, кокосовое молоко и нут, тушите 15 минут.', 'Вмешайте шпинат, посолите и подавайте с рисом.'] },
      { id: 'r-oat-chia', title: 'Овсянка на овсяном молоке с ягодами и чиа', servings: 1, meals: ['breakfast', 'snack'], cuisine: 'Домашняя', tags: ['каша', 'постное', 'быстро'],
        ing: [['oats', 50, 'г'], ['oat-milk', 200, 'мл'], ['berries-frozen', 80, 'г'], ['chia', 1, 'ст. л.']],
        steps: ['Залейте хлопья овсяным молоком и варите 5 минут, помешивая.', 'Вмешайте семена чиа и дайте постоять 3 минуты.', 'Выложите сверху ягоды.'] },
      { id: 'r-tofu-scramble', title: 'Тофу-скрэмбл с овощами', servings: 2, meals: ['breakfast'], cuisine: 'Домашняя', tags: ['постное', 'быстро'],
        ing: [['tofu', 250, 'г'], ['tomato', 1, 'шт'], ['bell-pepper', 0.5, 'шт'], ['spinach', 50, 'г'], ['turmeric', 0.5, 'ч. л.'], ['olive-oil', 1, 'ст. л.'], ['salt', 0, 'по вкусу'], ['black-pepper', 1, 'щепотка']],
        steps: ['Нарежьте помидор и перец небольшими кубиками.', 'Обжарьте перец на оливковом масле 3 минуты.', 'Раскрошите тофу руками прямо в сковороду, добавьте куркуму и перемешайте.', 'Добавьте помидор и шпинат, готовьте ещё 3–4 минуты. Посолите и поперчите.'] },
      { id: 'r-millet-pumpkin', title: 'Пшённая каша с тыквой', servings: 2, meals: ['breakfast'], cuisine: 'Русская', tags: ['каша', 'постное'],
        ing: [['millet', 100, 'г'], ['pumpkin', 250, 'г'], ['water', 450, 'мл'], ['raisins', 20, 'г'], ['salt', 1, 'щепотка'], ['cinnamon', 1, 'щепотка']],
        steps: ['Промойте пшено несколько раз горячей водой.', 'Нарежьте тыкву мелкими кубиками.', 'Залейте пшено и тыкву водой, посолите и варите под крышкой 20–25 минут на слабом огне.', 'Вмешайте изюм, посыпьте корицей и дайте постоять 5 минут.'] },
      { id: 'r-bean-stew', title: 'Тушёная фасоль с овощами', servings: 3, meals: ['lunch', 'dinner'], cuisine: 'Домашняя', tags: ['постное', 'бобовые'],
        ing: [['beans-canned', 400, 'г'], ['onion', 1, 'шт'], ['carrot', 1, 'шт'], ['bell-pepper', 1, 'шт'], ['canned-tomatoes', 400, 'г'], ['garlic', 2, 'шт'], ['paprika', 1, 'ч. л.'], ['olive-oil', 2, 'ст. л.'], ['parsley', 1, 'ст. л.'], ['salt', 0, 'по вкусу']],
        steps: ['Нарежьте лук, морковь и перец, обжарьте на масле 7 минут.', 'Добавьте чеснок и паприку, прогрейте 1 минуту.', 'Вылейте томаты, добавьте фасоль без жидкости и тушите 15 минут.', 'Посолите и посыпьте петрушкой.'] },
      { id: 'r-quinoa-salad', title: 'Салат с киноа, авокадо и черри', servings: 2, meals: ['lunch', 'dinner'], cuisine: 'Европейская', tags: ['салат', 'постное'],
        ing: [['quinoa', 120, 'г'], ['cherry', 10, 'шт'], ['cucumber', 1, 'шт'], ['avocado', 1, 'шт'], ['lemon', 2, 'ст. л.'], ['olive-oil', 2, 'ст. л.'], ['parsley', 2, 'ст. л.'], ['salt', 0, 'по вкусу']],
        steps: ['Промойте киноа и отварите в подсоленной воде 15 минут, остудите.', 'Разрежьте черри пополам, нарежьте огурец и авокадо.', 'Смешайте всё с киноа и петрушкой.', 'Заправьте лимонным соком и маслом, посолите.'] },
      { id: 'r-spinach-feta-omelet', title: 'Омлет со шпинатом и фетой', servings: 1, meals: ['breakfast'], cuisine: 'Европейская', tags: ['яйца', 'быстро'],
        ing: [['egg', 3, 'шт'], ['spinach', 50, 'г'], ['feta', 30, 'г'], ['butter', 5, 'г'], ['salt', 0, 'по вкусу']],
        steps: ['Взбейте яйца со щепоткой соли.', 'Растопите масло, обжарьте шпинат 1 минуту.', 'Залейте яйцами, посыпьте раскрошенной фетой.', 'Готовьте под крышкой 4–5 минут на слабом огне.'] },
      { id: 'r-pork-cauliflower', title: 'Свинина с цветной капустой под сыром', servings: 3, meals: ['lunch', 'dinner'], cuisine: 'Домашняя', tags: ['духовка'],
        ing: [['pork', 450, 'г'], ['cauliflower', 300, 'г'], ['butter', 40, 'г'], ['cheese', 80, 'г'], ['garlic', 3, 'шт'], ['olive-oil', 1, 'ст. л.'], ['herbs', 1, 'ч. л.'], ['salt', 0, 'по вкусу'], ['black-pepper', 1, 'щепотка']],
        steps: ['Разогрейте духовку до 200 °C.', 'Нарежьте свинину кусками, натрите солью, перцем, травами и чесноком.', 'Разберите капусту на соцветия, смешайте с маслом и растопленным сливочным маслом.', 'Запекайте 30 минут, затем посыпьте сыром и запекайте ещё 7 минут.'] },
      { id: 'r-chicken-broccoli-soup', title: 'Куриный суп с брокколи и шпинатом', servings: 4, meals: ['lunch'], cuisine: 'Домашняя', tags: ['суп', 'курица'],
        ing: [['chicken-breast', 350, 'г'], ['broccoli', 300, 'г'], ['spinach', 80, 'г'], ['onion', 0.5, 'шт'], ['water', 1500, 'мл'], ['bay-leaf', 1, 'шт'], ['salt', 0, 'по вкусу']],
        steps: ['Залейте курицу водой, добавьте лук и лавровый лист, варите 25 минут.', 'Выньте курицу, нарежьте кусочками и верните в бульон.', 'Добавьте соцветия брокколи и варите 7 минут.', 'Вмешайте шпинат, посолите и выключите огонь.'] },
      { id: 'r-garlic-shrimp-zucchini', title: 'Креветки в чесночном масле с кабачком', servings: 2, meals: ['dinner', 'lunch'], cuisine: 'Средиземноморская', tags: ['морепродукты', 'быстро'],
        ing: [['shrimp', 300, 'г'], ['zucchini', 1, 'шт'], ['garlic', 3, 'шт'], ['butter', 30, 'г'], ['olive-oil', 2, 'ст. л.'], ['lemon', 1, 'ч. л.'], ['parsley', 1, 'ст. л.'], ['salt', 0, 'по вкусу']],
        steps: ['Нарежьте кабачок полукружиями и обжарьте на оливковом масле 5 минут.', 'Добавьте сливочное масло и рубленый чеснок.', 'Выложите креветки и прогрейте 3 минуты.', 'Сбрызните лимонным соком, посолите и посыпьте петрушкой.'] },
      { id: 'r-stuffed-eggs', title: 'Яйца, фаршированные тунцом', servings: 2, meals: ['snack'], cuisine: 'Домашняя', tags: ['яйца', 'закуска'],
        ing: [['egg', 4, 'шт'], ['tuna-canned', 0.5, 'шт'], ['mayo', 2, 'ст. л.'], ['dill', 1, 'ст. л.'], ['salt', 0, 'по вкусу']],
        steps: ['Сварите яйца вкрутую (9 минут), остудите и разрежьте пополам.', 'Достаньте желтки и разомните их с тунцом и майонезом.', 'Наполните белки начинкой и посыпьте укропом.'] },
      { id: 'r-tofu-rice', title: 'Рис с овощами и тофу', servings: 3, meals: ['lunch', 'dinner'], cuisine: 'Азиатская', tags: ['постное', 'вок'],
        ing: [['rice', 180, 'г'], ['tofu', 250, 'г'], ['veg-mix', 400, 'г'], ['soy-sauce', 2, 'ст. л.'], ['sunflower-oil', 2, 'ст. л.'], ['garlic', 2, 'шт'], ['ginger', 1, 'ч. л.']],
        steps: ['Отварите рис.', 'Нарежьте тофу кубиками и обжарьте на половине масла до корочки, переложите.', 'На оставшемся масле обжарьте чеснок, имбирь и овощную смесь 6–7 минут.', 'Добавьте рис, тофу и соевый соус, перемешайте и прогрейте 2 минуты.'] },
      { id: 'r-pumpkin-soup', title: 'Суп-пюре из тыквы на кокосовом молоке', servings: 4, meals: ['lunch', 'dinner'], cuisine: 'Домашняя', tags: ['суп', 'постное'],
        ing: [['pumpkin', 600, 'г'], ['coconut-milk', 200, 'мл'], ['onion', 1, 'шт'], ['carrot', 1, 'шт'], ['ginger', 1, 'ч. л.'], ['olive-oil', 1, 'ст. л.'], ['water', 500, 'мл'], ['pumpkin-seeds', 20, 'г'], ['salt', 0, 'по вкусу']],
        steps: ['Нарежьте тыкву, лук и морковь кубиками.', 'Обжарьте лук и морковь на масле 5 минут, добавьте имбирь.', 'Добавьте тыкву и воду, варите 20 минут до мягкости.', 'Влейте кокосовое молоко, пробейте блендером и посолите.', 'Подавайте с тыквенными семечками.'] },
      // ---- Добавлены в v1.8: кето (жиры 60–85% калорий, углеводы ≤ 10%) ----
      { id: 'r-keto-salmon-scramble', title: 'Скрэмбл со сливочным сыром и сёмгой', servings: 1, meals: ['breakfast'], cuisine: 'Европейская', tags: ['яйца', 'быстро'],
        ing: [['egg', 3, 'шт'], ['cream-cheese', 30, 'г'], ['salmon-salted', 40, 'г'], ['butter', 10, 'г'], ['dill', 1, 'ч. л.'], ['salt', 0, 'по вкусу']],
        steps: ['Взбейте яйца со сливочным сыром.', 'Растопите масло, вылейте яйца и помешивайте лопаткой на слабом огне 2–3 минуты.', 'Снимите с огня, пока яйца ещё влажные.', 'Подавайте с ломтиками сёмги и укропом.'] },
      { id: 'r-keto-creamy-chicken', title: 'Куриные бёдра в сливочном соусе со шпинатом', servings: 3, meals: ['lunch', 'dinner'], cuisine: 'Европейская', tags: ['курица', 'соус'],
        ing: [['chicken-thigh', 450, 'г'], ['cream', 200, 'мл'], ['butter', 30, 'г'], ['spinach', 100, 'г'], ['parmesan', 30, 'г'], ['garlic', 2, 'шт'], ['salt', 0, 'по вкусу']],
        steps: ['Обжарьте бёдра на сливочном масле по 5 минут с каждой стороны, переложите.', 'В той же сковороде прогрейте чеснок, влейте сливки и добавьте тёртый пармезан.', 'Верните курицу и тушите 10 минут под крышкой.', 'Вмешайте шпинат, посолите и прогрейте ещё 2 минуты.'] },
      { id: 'r-keto-mackerel', title: 'Скумбрия, запечённая с маслом и травами', servings: 3, meals: ['dinner', 'lunch'], cuisine: 'Домашняя', tags: ['рыба', 'духовка'],
        ing: [['mackerel', 600, 'г'], ['butter', 30, 'г'], ['lemon', 1, 'ст. л.'], ['herbs', 1, 'ч. л.'], ['arugula', 60, 'г'], ['olive-oil', 1, 'ст. л.'], ['salt', 0, 'по вкусу']],
        steps: ['Разогрейте духовку до 200 °C.', 'Посолите рыбу, натрите травами, внутрь положите кусочки сливочного масла.', 'Запекайте 20–25 минут.', 'Подавайте с рукколой, заправленной маслом и лимонным соком.'] },
      { id: 'r-keto-avocado-bacon', title: 'Салат с авокадо, беконом и яйцом', servings: 2, meals: ['lunch', 'dinner'], cuisine: 'Европейская', tags: ['салат', 'быстро'],
        ing: [['avocado', 1, 'шт'], ['bacon', 4, 'шт'], ['egg', 2, 'шт'], ['lettuce', 60, 'г'], ['olive-oil', 1, 'ст. л.'], ['lemon', 1, 'ч. л.'], ['salt', 0, 'по вкусу']],
        steps: ['Сварите яйца (8 минут) и обжарьте бекон до хруста.', 'Нарежьте авокадо, яйца и бекон.', 'Выложите на листья салата.', 'Заправьте оливковым маслом и лимонным соком, посолите.'] },
      { id: 'r-keto-burger', title: 'Говяжьи котлеты с сыром без булки', servings: 3, meals: ['lunch', 'dinner'], cuisine: 'Американская', tags: ['говядина'],
        ing: [['ground-beef', 500, 'г'], ['cheese', 60, 'г'], ['pickles', 3, 'шт'], ['lettuce', 60, 'г'], ['mayo', 1, 'ст. л.'], ['olive-oil', 1, 'ст. л.'], ['salt', 0, 'по вкусу'], ['black-pepper', 1, 'щепотка']],
        steps: ['Посолите и поперчите фарш, сформируйте 6 котлет.', 'Обжарьте на масле по 4 минуты с каждой стороны.', 'Положите на котлеты ломтики сыра и накройте крышкой на 1 минуту.', 'Подавайте на листьях салата с маринованными огурцами и майонезом.'] },
      { id: 'r-keto-avocado-salmon', title: 'Авокадо со слабосолёной сёмгой', servings: 2, meals: ['snack', 'breakfast'], cuisine: 'Домашняя', tags: ['без готовки', 'быстро'],
        ing: [['avocado', 1, 'шт'], ['salmon-salted', 80, 'г'], ['lemon', 1, 'ч. л.'], ['black-pepper', 1, 'щепотка']],
        steps: ['Разрежьте авокадо пополам и удалите косточку.', 'Сбрызните лимонным соком и поперчите.', 'Подавайте с ломтиками сёмги.'] }
    ];
    var V17_RECIPE_IDS = ['r-keto-eggs', 'r-tuna-salad', 'r-chicken-thighs-veg', 'r-cheese-nuts', 'r-chickpea-curry', 'r-oat-chia', 'r-tofu-scramble', 'r-millet-pumpkin',
      'r-bean-stew', 'r-quinoa-salad', 'r-spinach-feta-omelet', 'r-pork-cauliflower', 'r-chicken-broccoli-soup', 'r-garlic-shrimp-zucchini', 'r-stuffed-eggs', 'r-tofu-rice', 'r-pumpkin-soup'];
    var V18_RECIPE_IDS = ['r-keto-salmon-scramble', 'r-keto-creamy-chicken', 'r-keto-mackerel', 'r-keto-avocado-bacon', 'r-keto-burger', 'r-keto-avocado-salmon'];
    /* Рецепты, переделанные в v1.8 в кето-версии: обновляем у пользователя, если он их не менял */
    var V18_UPDATED_IDS = ['r-tuna-salad', 'r-chicken-thighs-veg', 'r-pork-cauliflower', 'r-garlic-shrimp-zucchini', 'r-stuffed-eggs'];

    /* Встроенные диеты. Диета = исключённые категории + отдельные продукты − исключения (allow) + необязательный лимит углеводов на порцию.
       Новый продукт в исключённой категории исключается автоматически. */
    var DEFAULT_DIETS = [
      { id: 'vegetarian', name: 'Вегетарианская', emoji: '🥦', categories: ['meat', 'fish'], products: [], allow: [], maxCarbs: null },
      { id: 'vegan', name: 'Веганская', emoji: '🌱', categories: ['meat', 'fish', 'dairy'], products: ['honey'], allow: [], maxCarbs: null },
      { id: 'gluten-free', name: 'Безглютеновая', emoji: '🌾', categories: ['bread'],
        products: ['flour', 'pasta', 'spaghetti', 'noodles', 'couscous', 'bulgur', 'semolina', 'breadcrumbs', 'granola', 'oats', 'soy-sauce', 'crab-sticks', 'sausages', 'oat-milk'], allow: [], maxCarbs: null },
      { id: 'lactose-free', name: 'Безлактозная', emoji: '🥛', categories: [],
        products: ['milk', 'milk-32', 'kefir', 'ryazhenka', 'cottage-cheese-5', 'cottage-cheese-0', 'greek-yogurt', 'yogurt', 'sour-cream', 'cream', 'cream-cheese', 'mozzarella', 'feta', 'brynza', 'sausages'], allow: [], maxCarbs: null },
      { id: 'keto', name: 'Кето', emoji: '🥑', categories: ['grains', 'bread'],
        products: ['sugar', 'honey', 'jam', 'vanilla-sugar', 'potato', 'sweet-potato', 'beet', 'corn-canned', 'peas-canned', 'peas-frozen', 'banana', 'apple', 'orange', 'pear', 'grapes',
          'mandarin', 'peach', 'plum', 'mango', 'pomegranate', 'kiwi', 'raisins', 'dried-apricots', 'prunes', 'dates', 'orange-juice', 'oat-milk', 'ketchup', 'starch', 'breadcrumbs', 'crab-sticks'],
        allow: [], maxCarbs: null, maxCarbsPct: 10, minFatPct: 60, macro: 'keto' }
    ];
    /* Кето в v1.8: вместо «≤ 15 г углеводов на порцию» — доли калорий (не зависят от размера порции) и своя норма КБЖУ */
    var KETO_RULES = { maxCarbs: null, maxCarbsPct: 10, minFatPct: 60, macro: 'keto' };
    function defaultDiets() { return DEFAULT_DIETS.map(function (d) { var c = U.clone(d); c.builtin = true; return c; }); }
    /* «Всегда есть дома»: эти продукты холодильник не требует (соль, перец, вода, масло, все специи) */
    function defaultPantry() { return { categories: ['spices'], products: ['salt', 'black-pepper', 'water', 'sunflower-oil', 'olive-oil'] }; }

    /* Фото по умолчанию: Unsplash (бесплатная лицензия Unsplash) и Wikimedia Commons (свободные лицензии).
       Автор и источник — в подписи под фото, по ссылке — страница фото с лицензией */
    var DEFAULT_PHOTOS = {
      'r-oatmeal': { url: 'https://images.unsplash.com/photo-1548807371-30dc1bbe6cb5?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/Vk044I3w1gI', source: 'Alexandru Acea / Unsplash' },
      'r-syrniki': { url: 'https://images.unsplash.com/photo-1682219179121-36821753748d?w=1200&h=750&fit=crop&q=80&fm=jpg&crop=focalpoint&fp-x=0.5&fp-y=0.73', page: 'https://unsplash.com/photos/WXNfNUFSeSU', source: 'Masha Koko / Unsplash' },
      'r-omelet': { url: 'https://images.unsplash.com/photo-1677844592730-ce9c936d8f1a?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/SCZP5rvZINk', source: 'Bakd&Raw by Karolin Baitinger / Unsplash' },
      'r-avocado-toast': { url: 'https://images.unsplash.com/photo-1719520670204-dbe1903a789f?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/P7oGUDHswIA', source: 'Andrew Spencer / Unsplash' },
      'r-yogurt-granola': { url: 'https://images.unsplash.com/photo-1633104060731-32143505bacc?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/z71M3cfW40c', source: 'Shayna Douglas / Unsplash' },
      'r-salmon-toast': { url: 'https://images.unsplash.com/photo-1627308594171-ebd99b564ff6?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/ITiXi1rN4xA', source: 'Vicky Ng / Unsplash' },
      'r-borsch': { url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/Borscht_served.jpg/960px-Borscht_served.jpg', page: 'https://commons.wikimedia.org/wiki/File:Borscht_served.jpg', source: 'Wikimedia Commons' },
      'r-plov': { url: 'https://images.unsplash.com/photo-1634324092526-91f5e878b72f?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/ojDzHZHcVx4', source: 'Eugene Krasnaok / Unsplash' },
      'r-pasta-navy': { url: 'https://images.unsplash.com/photo-1779914895538-33353ea52e64?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/Zpag5-WH_1Y', source: 'Csaba Lévai / Unsplash' },
      'r-buckwheat-mush': { url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e0/Grechka.jpg/960px-Grechka.jpg', page: 'https://commons.wikimedia.org/wiki/File:Grechka.jpg', source: 'Kagor / Wikimedia Commons' },
      'r-lentil-soup': { url: 'https://images.unsplash.com/photo-1476718406336-bb5a9690ee2a?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/w6ftFbPCs9I', source: 'Cala / Unsplash' },
      'r-caesar': { url: 'https://images.unsplash.com/photo-1605291535065-e1d52d2b264a?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/1kOsQoehjZA', source: 'logan jeffrey / Unsplash' },
      'r-salmon-broccoli': { url: 'https://images.unsplash.com/photo-1675209705883-7aec595f5aa8?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/RZV1-tNbHy4', source: 'Camara Negra / Unsplash' },
      'r-cutlets-mash': { url: 'https://images.unsplash.com/photo-1652690772758-45df96e11c50?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/GPta6bE6Nvw', source: 'Kristóf Koródy / Unsplash' },
      'r-turkey-ragout': { url: 'https://images.unsplash.com/photo-1604908177453-7462950a6a3b?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/TvMWBS6TIsg', source: 'Farhad Ibrahimzade / Unsplash' },
      'r-cod-rice': { url: 'https://images.unsplash.com/photo-1706468238744-6af411063336?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/WaFaLcxXfLM', source: 'Jason Leung / Unsplash' },
      'r-bolognese': { url: 'https://images.unsplash.com/photo-1598866594230-a7c12756260f?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/qits91IZv1o', source: 'Danijela Prijovic / Unsplash' },
      'r-shakshuka': { url: 'https://images.unsplash.com/photo-1590412200988-a436970781fa?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/422N7Nwq5XY', source: 'Yoav Aziz / Unsplash' },
      'r-smoothie': { url: 'https://images.unsplash.com/photo-1570696516188-ade861b84a49?w=1200&h=750&fit=crop&q=80&fm=jpg&crop=focalpoint&fp-x=0.47&fp-y=0.66&fp-z=1.4', page: 'https://unsplash.com/photos/hsTwPUzFegQ', source: 'Denis / Unsplash' },
      'r-cottage-berries': { url: 'https://images.unsplash.com/photo-1614630536994-a6b781d56e15?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/odLdpSRRZtQ', source: 'Olena Bohovyk / Unsplash' },
      'r-hummus': { url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9e/Hummus_Dip_(30863436677).jpg/960px-Hummus_Dip_(30863436677).jpg', page: 'https://commons.wikimedia.org/wiki/File:Hummus_Dip_(30863436677).jpg', source: 'Wikimedia Commons' },
      'r-apple-pb': { url: 'https://images.unsplash.com/photo-1642339800118-eb551cfa1434?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/F-ReDCrjQbo', source: 'Aasiya Khan / Unsplash' },
      'r-energy-balls': { url: 'https://images.unsplash.com/photo-1647532197692-ad9f2ecae422?w=1200&h=750&fit=crop&q=80&fm=jpg', page: 'https://unsplash.com/photos/1FIZR8YWbzk', source: 'Nature Zen / Unsplash' },
      'r-greek-salad': { url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/20240428_Greek_Salad_Restaurant_Elia_anagoria.jpg/960px-20240428_Greek_Salad_Restaurant_Elia_anagoria.jpg', page: 'https://commons.wikimedia.org/wiki/File:20240428_Greek_Salad_Restaurant_Elia_anagoria.jpg', source: 'Anagoria / Wikimedia Commons' }
    };
    /* Прежние фото по умолчанию (до v6): по ним миграция узнаёт, что пользователь фото не менял */
    var LEGACY_DEFAULT_URLS = ['https://cdn.lifehacker.ru/wp-content/uploads/2024/11/103_1732278919.jpg', 'https://static.1000.menu/img/content/26232/salat-s-balzamicheskim-uksusom_1521917351_10_max.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/15/Ratatouille_001.jpg/960px-Ratatouille_001.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/18/Shakshuka_by_Calliopejen1.jpg/960px-Shakshuka_by_Calliopejen1.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1e/Red_lentil_soup.jpg/960px-Red_lentil_soup.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/23/Caesar_salad_(2).jpg/960px-Caesar_salad_(2).jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/27/Navy-style_2020-01-30_%D0%9C%D0%B0%D0%BA%D0%B0%D1%80%D0%BE%D0%BD%D1%8B_%C2%AB%D0%BF%D0%BE-%D1%84%D0%BB%D0%BE%D1%82%D1%81%D0%BA%D0%B8%C2%BB.jpg/960px-Navy-style_2020-01-30_%D0%9C%D0%B0%D0%BA%D0%B0%D1%80%D0%BE%D0%BD%D1%8B_%C2%AB%D0%BF%D0%BE-%D1%84%D0%BB%D0%BE%D1%82%D1%81%D0%BA%D0%B8%C2%BB.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3f/Banna_Yogurt_Smoothie.jpg/960px-Banna_Yogurt_Smoothie.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4a/Omelette_de_verduras.jpg/960px-Omelette_de_verduras.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/Yogurt,_fruit,_granola_bowl_(34999358091).jpg/960px-Yogurt,_fruit,_granola_bowl_(34999358091).jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7a/Plated_grilled_fish.jpg/960px-Plated_grilled_fish.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/82/Cottage_Cheese_homemade.jpg/960px-Cottage_Cheese_homemade.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/96/%D0%93%D1%80%D0%B5%D1%87%D0%BD%D0%B5%D0%B2%D0%B0%D1%8F_%D0%BA%D0%B0%D1%88%D0%B0.jpg/960px-%D0%93%D1%80%D0%B5%D1%87%D0%BD%D0%B5%D0%B2%D0%B0%D1%8F_%D0%BA%D0%B0%D1%88%D0%B0.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ac/Greek_salad.jpg/960px-Greek_salad.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bd/Avocado_toast_with_eggs_(28508171495).jpg/960px-Avocado_toast_with_eggs_(28508171495).jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Spaghetti_bolognese.jpg/960px-Spaghetti_bolognese.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Breakfast_porridge.jpg/960px-Breakfast_porridge.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c9/Syrniki_with_fruits.jpg/960px-Syrniki_with_fruits.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/Ragout.jpg/960px-Ragout.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e3/Salmon_Cream_Cheese_Sandwiches.jpg/960px-Salmon_Cream_Cheese_Sandwiches.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Pilaf_with_chicken.jpg/960px-Pilaf_with_chicken.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/Grilled_plated_salmon_fillet.jpg/960px-Grilled_plated_salmon_fillet.jpg'];
    function defaultPhoto(id) {
      var d = DEFAULT_PHOTOS[id];
      return d ? { photoUrl: d.url, photoCredit: { source: d.source || 'Wikimedia Commons', page: d.page } } : null;
    }

    function buildRecipes() {
      var t0 = Date.parse('2026-01-01T09:00:00Z');
      return RAW_RECIPES.map(function (r, i) {
        var dp = defaultPhoto(r.id);
        return {
          id: r.id, title: r.title, photo: null, photoId: null, photoUrl: dp ? dp.photoUrl : null, photoCredit: dp ? dp.photoCredit : null, servings: r.servings,
          meals: r.meals.slice(), cuisine: r.cuisine || '', tags: (r.tags || []).slice(),
          ingredients: r.ing.map(function (x) { return { productId: x[0], amount: x[1], unit: x[2] }; }),
          steps: r.steps.slice(), draft: false,
          createdAt: t0 + i * 3600000, updatedAt: t0 + i * 3600000
        };
      });
    }

    function defaultSettings() {
      return {
        theme: null,
        profile: { sex: 'female', age: 30, height: 165, weight: 62, activity: 1.375, goal: 'maintain' },
        targets: null, targetsManual: false,
        restrictions: { excluded: [], diets: [], moreProtein: false, moreFiber: false },
        diets: defaultDiets(),
        pantry: defaultPantry(),
        mealsPerDay: 3, people: 1,
        categories: U.clone(DEFAULT_CATEGORIES)
      };
    }

    return { UNITS: UNITS, MEALS: MEALS, DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,
      buildProducts: buildProducts, buildRecipes: buildRecipes, V17_RECIPE_IDS: V17_RECIPE_IDS, V18_RECIPE_IDS: V18_RECIPE_IDS, V18_UPDATED_IDS: V18_UPDATED_IDS, defaultDiets: defaultDiets, defaultPantry: defaultPantry, KETO_RULES: KETO_RULES, defaultPhoto: defaultPhoto, LEGACY_DEFAULT_URLS: LEGACY_DEFAULT_URLS, defaultSettings: defaultSettings,
      mealName: function (id) { var m = MEALS.filter(function (x) { return x.id === id; })[0]; return m ? m.name : id; } };
  })();
  Foodly.Models = Models;

  /* =======================================================================
   * Storage: DB — загрузка/сохранение состояния приложения
   * ======================================================================= */
  var DB = (function () {
    var state = { products: [], recipes: [], shopping: [], fridge: [], plan: null, settings: null };
    var productMap = {};
    var listeners = [];

    function rebuildIndex() {
      productMap = {};
      state.products.forEach(function (p) { productMap[p.id] = p; });
    }
    function seed() {
      state.products = Models.buildProducts();
      state.recipes = Models.buildRecipes();
      state.shopping = [];
      state.fridge = [];
      state.plan = null;
      var theme = state.settings ? state.settings.theme : null;
      state.settings = Models.defaultSettings();
      state.settings.theme = theme;
    }
    function ensureIntegrity() {
      var s = state.settings || {};
      var d = Models.defaultSettings();
      Object.keys(d).forEach(function (k) { if (s[k] === undefined) s[k] = d[k]; });
      if (!Array.isArray(s.categories) || !s.categories.length) s.categories = d.categories;
      if (!s.categories.some(function (c) { return c.id === 'other'; })) s.categories.push({ id: 'other', name: 'Прочее' });
      s.restrictions = s.restrictions || d.restrictions;
      if (!Array.isArray(s.restrictions.excluded)) s.restrictions.excluded = [];
      // диеты: недостающие встроенные добавляем по id; из выбранных убираем несуществующие
      if (!Array.isArray(s.diets)) s.diets = Models.defaultDiets();
      var haveDiet = {}; s.diets.forEach(function (x) { haveDiet[x.id] = true; });
      Models.defaultDiets().forEach(function (x) { if (!haveDiet[x.id]) s.diets.push(x); });
      if (!Array.isArray(s.restrictions.diets)) s.restrictions.diets = [];
      s.restrictions.diets = s.restrictions.diets.filter(function (id) { return s.diets.some(function (x) { return x.id === id; }); });
      if (!s.pantry || typeof s.pantry !== 'object') s.pantry = Models.defaultPantry();
      if (!Array.isArray(s.pantry.categories)) s.pantry.categories = [];
      if (!Array.isArray(s.pantry.products)) s.pantry.products = [];
      s.profile = Object.assign({}, d.profile, s.profile || {});
      if (!s.targets || !(s.targets.kcal > 0)) { s.targets = Nutrition.targetsFor(s); s.targetsManual = false; }
      else if (!s.targetsManual) s.targets = Nutrition.targetsFor(s);   // расчётная норма всегда соответствует выбранным диетам
      state.settings = s;
      // новые встроенные продукты из обновлений приложения
      var have = {};
      state.products.forEach(function (p) { have[p.id] = true; });
      Models.buildProducts().forEach(function (p) { if (!have[p.id]) state.products.push(p); });
      if (!Array.isArray(state.recipes)) state.recipes = [];
      if (!Array.isArray(state.shopping)) state.shopping = [];
      if (!Array.isArray(state.fridge)) state.fridge = [];
      state.fridge = state.fridge.filter(function (x) { return x && typeof x === 'object' && x.productId; });
      state.fridge.forEach(function (x) { if (!x.id) x.id = U.uid('fr'); if (!x.unit) x.unit = 'г'; if (x.amount === undefined) x.amount = null; if (x.expires === undefined) x.expires = null; });
    }
    function init() {
      var meta = Storage.get('meta', null);
      if (!meta) {
        seed();
        state.settings.theme = Storage.get('theme', null);
        ensureIntegrity();
        rebuildIndex();
        saveAll();
        return;
      }
      var data = {
        products: Storage.get('products', null) || Models.buildProducts(),
        recipes: Storage.get('recipes', []),
        shopping: Storage.get('shopping', []),
        fridge: Storage.get('fridge', []),
        plan: Storage.get('plan', null),
        settings: Storage.get('settings', null) || Models.defaultSettings()
      };
      var migrated = false;
      if ((meta.schemaVersion || 1) < Storage.SCHEMA_VERSION) {
        data = Storage.migrate(data, meta.schemaVersion || 1);
        migrated = true;
      }
      state.products = data.products; state.recipes = data.recipes; state.shopping = data.shopping; state.fridge = data.fridge;
      state.plan = data.plan; state.settings = data.settings;
      ensureIntegrity();
      rebuildIndex();
      if (migrated) saveAll();
    }
    function save(key) {
      var ok = Storage.set(key, state[key]);
      if (key === 'products') rebuildIndex();
      listeners.forEach(function (fn) { fn(key); });
      return ok;
    }
    function saveAll() {
      var ok = true;
      ['products', 'recipes', 'shopping', 'fridge', 'plan', 'settings'].forEach(function (k) { ok = Storage.set(k, state[k]) && ok; });
      Storage.set('meta', { schemaVersion: Storage.SCHEMA_VERSION, updatedAt: Date.now() });
      rebuildIndex();
      listeners.forEach(function (fn) { fn('*'); });
      return ok;
    }
    function product(id) { return productMap[id] || null; }
    function findProductByName(name) {
      var n = U.norm(name);
      if (!n) return null;
      for (var i = 0; i < state.products.length; i++) if (U.norm(state.products[i].name) === n) return state.products[i];
      return null;
    }
    function searchProducts(q, limit) {
      var n = U.norm(q);
      if (!n) return [];
      var starts = [], contains = [];
      state.products.forEach(function (p) {
        var pn = U.norm(p.name);
        if (pn.indexOf(n) === 0) starts.push(p);
        else if (pn.indexOf(n) > 0) contains.push(p);
      });
      return starts.concat(contains).slice(0, limit || 8);
    }
    function recipe(id) { return state.recipes.filter(function (r) { return r.id === id; })[0] || null; }
    function categoryName(id) {
      var c = state.settings.categories.filter(function (x) { return x.id === id; })[0];
      return c ? c.name : 'Прочее';
    }
    function exportData() {
      return {
        app: 'Foodly!', schemaVersion: Storage.SCHEMA_VERSION, exportedAt: new Date().toISOString(),
        data: U.clone({ products: state.products, recipes: state.recipes, shopping: state.shopping, fridge: state.fridge, plan: state.plan, settings: state.settings })
      };
    }
    return { state: state, init: init, save: save, saveAll: saveAll, seed: seed, ensureIntegrity: ensureIntegrity,
      product: product, findProductByName: findProductByName, searchProducts: searchProducts, recipe: recipe,
      categoryName: categoryName, exportData: exportData, onChange: function (fn) { listeners.push(fn); } };
  })();
  Foodly.DB = DB;

  /* =======================================================================
   * Nutrition — перевод единиц в граммы, КБЖУ рецептов, профиль и цели
   * ======================================================================= */
  var Nutrition = (function () {
    var NON_COUNTED = { 'щепотка': true, 'по вкусу': true };
    var KEYS = ['kcal', 'protein', 'fat', 'carbs', 'fiber'];

    /* Возвращает {grams, status}: ok | skip (не учитывается) | missing (нет веса единицы) | unknown (нет продукта) */
    function toGrams(amount, unit, product) {
      amount = Number(amount) || 0;
      if (NON_COUNTED[unit]) return { grams: 0, status: 'skip' };
      if (!product) return { grams: 0, status: 'unknown' };
      var units = product.units || {};
      switch (unit) {
        case 'г': return { grams: amount, status: 'ok' };
        case 'кг': return { grams: amount * 1000, status: 'ok' };
        case 'мл': return units['мл'] ? { grams: amount * units['мл'], status: 'ok' } : { grams: 0, status: 'missing' };
        case 'л': return units['мл'] ? { grams: amount * 1000 * units['мл'], status: 'ok' } : { grams: 0, status: 'missing' };
        default:
          return units[unit] ? { grams: amount * units[unit], status: 'ok' } : { grams: 0, status: 'missing' };
      }
    }
    function empty() { return { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0 }; }
    function ingredientNutrition(ing) {
      var p = DB.product(ing.productId);
      var g = toGrams(ing.amount, ing.unit, p);
      var out = empty();
      if (g.status === 'ok' && p) KEYS.forEach(function (k) { out[k] = (p.per100[k] || 0) * g.grams / 100; });
      out.grams = g.grams; out.status = g.status;
      return out;
    }
    function recipeTotals(recipe) {
      var t = empty(); var issues = [];
      (recipe.ingredients || []).forEach(function (ing, i) {
        var n = ingredientNutrition(ing);
        if (n.status === 'missing' || n.status === 'unknown') issues.push(i);
        KEYS.forEach(function (k) { t[k] += n[k]; });
      });
      t.issues = issues;
      return t;
    }
    function perServing(recipe) {
      var t = recipeTotals(recipe);
      var s = Math.max(1, Number(recipe.servings) || 1);
      var out = {};
      KEYS.forEach(function (k) { out[k] = t[k] / s; });
      out.issues = t.issues;
      return out;
    }
    function badges(ps) {
      var b = [];
      if (ps.kcal > 0 && ps.protein * 4 >= 0.25 * ps.kcal) b.push({ id: 'protein', label: 'Высокобелковое' });
      if (ps.fiber >= 6) b.push({ id: 'fiber', label: 'Много клетчатки' });
      return b;
    }
    function scale(n, k) { var o = {}; KEYS.forEach(function (x) { o[x] = (n[x] || 0) * k; }); return o; }
    function add(a, b) { var o = {}; KEYS.forEach(function (x) { o[x] = (a[x] || 0) + (b[x] || 0); }); return o; }

    var ACTIVITY = [
      { v: 1.2, label: 'Минимальная (сидячая работа)' },
      { v: 1.375, label: 'Низкая (1–3 тренировки в неделю)' },
      { v: 1.55, label: 'Средняя (3–5 тренировок)' },
      { v: 1.725, label: 'Высокая (6–7 тренировок)' },
      { v: 1.9, label: 'Очень высокая (физический труд + спорт)' }
    ];
    /* Миффлин–Сан Жеор × активность; похудение −15%, набор +10%.
       mode = 'keto' — кетогенное распределение (калории те же):
         углеводы (усвояемые, «чистые») = 5% калорий, но 20–30 г в день;
         белок = 1,6 / 1,4 / 1,7 г на кг веса (похудение / поддержание / набор), не больше 25% калорий;
         жиры = всё остальное: (ккал − 4·Б − 4·У) / 9 ≈ 70–77% калорий. */
    function calcTargets(p, mode) {
      var w = Number(p.weight) || 60, h = Number(p.height) || 165, a = Number(p.age) || 30;
      var bmr = 10 * w + 6.25 * h - 5 * a + (p.sex === 'male' ? 5 : -161);
      var kcal = bmr * (Number(p.activity) || 1.2);
      if (p.goal === 'lose') kcal *= 0.85;
      if (p.goal === 'gain') kcal *= 1.10;
      kcal = Math.round(kcal / 10) * 10;
      if (mode === 'keto') {
        var kc = Math.min(30, Math.max(20, Math.round(kcal * 0.05 / 4)));
        var kp = Math.round(Math.min(w * (p.goal === 'lose' ? 1.6 : p.goal === 'gain' ? 1.7 : 1.4), kcal * 0.25 / 4));
        var kf = Math.max(0, Math.round((kcal - kp * 4 - kc * 4) / 9));
        return { kcal: kcal, protein: kp, fat: kf, carbs: kc };
      }
      var protein = Math.round(w * (p.goal === 'lose' ? 2.0 : 1.6));
      var fat = Math.round(kcal * 0.28 / 9);
      var carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
      return { kcal: kcal, protein: protein, fat: fat, carbs: carbs };
    }
    /* Режим расчёта нормы по выбранным для меню диетам: 'keto' или null */
    function macroMode(settings, restrictions) {
      var ids = ((restrictions || (settings && settings.restrictions)) || {}).diets || [];
      return ((settings && settings.diets) || []).some(function (d) { return d.macro === 'keto' && ids.indexOf(d.id) >= 0; }) ? 'keto' : null;
    }
    function targetsFor(settings) { return calcTargets(settings.profile || {}, macroMode(settings)); }
    /* Доли калорий из белков, жиров и углеводов (по 4/9/4 ккал на грамм) */
    function macroPct(n) {
      var k = (n.protein || 0) * 4 + (n.fat || 0) * 9 + (n.carbs || 0) * 4;
      if (!(k > 0)) return { protein: 0, fat: 0, carbs: 0 };
      return { protein: (n.protein || 0) * 4 / k * 100, fat: (n.fat || 0) * 9 / k * 100, carbs: (n.carbs || 0) * 4 / k * 100 };
    }
    return { toGrams: toGrams, ingredientNutrition: ingredientNutrition, recipeTotals: recipeTotals, perServing: perServing,
      badges: badges, scale: scale, add: add, empty: empty, calcTargets: calcTargets, macroMode: macroMode, targetsFor: targetsFor, macroPct: macroPct, ACTIVITY: ACTIVITY, NON_COUNTED: NON_COUNTED };
  })();
  Foodly.Nutrition = Nutrition;

  /* =======================================================================
   * Diets — проверка рецептов на соответствие диетам
   * ======================================================================= */
  var Diets = (function () {
    function all() { return (DB.state.settings && DB.state.settings.diets) || []; }
    function get(id) { return all().filter(function (d) { return d.id === id; })[0] || null; }
    function excludesProduct(diet, pid) {
      if (!diet || !pid) return false;
      if ((diet.allow || []).indexOf(pid) >= 0) return false;
      if ((diet.products || []).indexOf(pid) >= 0) return true;
      var p = DB.product(pid); return !!(p && (diet.categories || []).indexOf(p.category) >= 0);
    }
    function has(v) { return v != null && v !== ''; }
    function fits(recipe, diet) {
      if (!diet) return true;
      var bad = (recipe.ingredients || []).some(function (i) { return excludesProduct(diet, i.productId); });
      if (bad) return false;
      if (!has(diet.maxCarbs) && !has(diet.maxCarbsPct) && !has(diet.minFatPct)) return true;
      var ps = Nutrition.perServing(recipe);
      if (has(diet.maxCarbs) && ps.carbs > Number(diet.maxCarbs)) return false;
      // доли калорий: не зависят от размера порции, поэтому работают и при 0,5–2,5 порциях в меню
      var pct = Nutrition.macroPct(ps);
      if (!(ps.kcal > 0)) return true;
      if (has(diet.maxCarbsPct) && pct.carbs > Number(diet.maxCarbsPct) + 1e-9) return false;
      if (has(diet.minFatPct) && pct.fat < Number(diet.minFatPct) - 1e-9) return false;
      return true;
    }
    function fitsAll(recipe, ids) { return (ids || []).every(function (id) { var d = get(id); return !d || fits(recipe, d); }); }
    /* Диеты, которым рецепт подходит */
    function matching(recipe) { return all().filter(function (d) { return fits(recipe, d); }); }
    function label(d) { return (d.emoji ? d.emoji + ' ' : '') + d.name; }
    function names(ids) { return (ids || []).map(get).filter(Boolean).map(function (d) { return d.name; }); }
    return { all: all, get: get, excludesProduct: excludesProduct, fits: fits, fitsAll: fitsAll, matching: matching, label: label, names: names };
  })();
  Foodly.Diets = Diets;

  /* =======================================================================
   * Recipes — CRUD, поиск, фильтры, фото
   * ======================================================================= */
  var Recipes = (function () {
    function all() { return DB.state.recipes; }
    /* Готовые рецепты (без черновиков) — только они попадают в поиск, меню и колесо */
    function ready() { return DB.state.recipes.filter(function (r) { return !r.draft; }); }
    function drafts() { return DB.state.recipes.filter(function (r) { return r.draft; }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }); }
    function upsert(r) {
      var list = DB.state.recipes;
      r.updatedAt = Date.now();
      var i = list.findIndex(function (x) { return x.id === r.id; });
      if (i >= 0) list[i] = r; else { r.createdAt = r.createdAt || Date.now(); list.unshift(r); }
      return DB.save('recipes');
    }
    function remove(id) {
      var list = DB.state.recipes;
      var i = list.findIndex(function (x) { return x.id === id; });
      if (i < 0) return null;
      var removed = list.splice(i, 1)[0];
      DB.save('recipes');
      return { item: removed, index: i };
    }
    function restore(entry) {
      DB.state.recipes.splice(Math.min(entry.index, DB.state.recipes.length), 0, entry.item);
      DB.save('recipes');
    }
    function allTags() {
      var set = {};
      ready().forEach(function (r) {
        (r.tags || []).forEach(function (t) { if (t) set[t] = true; });
        if (r.cuisine) set[r.cuisine] = true;
      });
      return Object.keys(set).sort(function (a, b) { return a.localeCompare(b, 'ru'); });
    }
    function containsProduct(r, ids) {
      if (!ids || !ids.length) return false;
      return (r.ingredients || []).some(function (i) { return ids.indexOf(i.productId) >= 0; });
    }
    /* q: {text, meal, tag, kcalMin, kcalMax, badge, diets[], sort} */
    function query(q) {
      var text = U.norm(q.text);
      var res = ready().filter(function (r) {
        if (text) {
          var hay = U.norm(r.title) + ' ' + (r.ingredients || []).map(function (i) { var p = DB.product(i.productId); return p ? U.norm(p.name) : ''; }).join(' ');
          if (hay.indexOf(text) < 0) return false;
        }
        if (q.meal && (r.meals || []).indexOf(q.meal) < 0) return false;
        if (q.tag && (r.tags || []).indexOf(q.tag) < 0 && r.cuisine !== q.tag) return false;
        var ps = Nutrition.perServing(r);
        if (q.kcalMin != null && !isNaN(q.kcalMin) && ps.kcal < q.kcalMin) return false;
        if (q.kcalMax != null && !isNaN(q.kcalMax) && ps.kcal > q.kcalMax) return false;
        if (q.badge && !Nutrition.badges(ps).some(function (b) { return b.id === q.badge; })) return false;
        if (q.diets && q.diets.length && !Diets.fitsAll(r, q.diets)) return false;
        return true;
      });
      var sort = q.sort || 'new';
      res.sort(function (a, b) {
        if (sort === 'title') return a.title.localeCompare(b.title, 'ru');
        if (sort === 'kcal') return Nutrition.perServing(a).kcal - Nutrition.perServing(b).kcal;
        if (sort === 'kcal-desc') return Nutrition.perServing(b).kcal - Nutrition.perServing(a).kcal;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      return res;
    }
    /* Ужимаем фото до ~800 px по длинной стороне, JPEG ~0.75. Принимает File/Blob, возвращает Blob */
    function compressImage(file, maxSide, quality) {
      maxSide = maxSide || 800; quality = quality || 0.75;
      return new Promise(function (resolve, reject) {
        if (!file || !/^image\//.test(file.type)) { reject(new Error('Выберите файл изображения')); return; }
        var src = URL.createObjectURL(file);
        var img = new Image();
        img.onerror = function () { URL.revokeObjectURL(src); reject(new Error('Не удалось открыть изображение')); };
        img.onload = function () {
          URL.revokeObjectURL(src);
          var k = Math.min(1, maxSide / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          if (c.toBlob) c.toBlob(function (b) { b ? resolve(b) : reject(new Error('Не удалось сжать изображение')); }, 'image/jpeg', quality);
          else resolve(PhotoStore.dataURLToBlob(c.toDataURL('image/jpeg', quality)));
        };
        img.src = src;
      });
    }
    var EMOJI_RULES = [
      [/яблок/, '🍏'], [/суп|борщ|(^|\s)щи(\s|$)|солянк/, '🍲'], [/салат/, '🥗'], [/(^|\s)паста(\s|$)|спагет|макарон|лапш/, '🍝'],
      [/лосос|сёмг|семг|треск|рыб|минта|хек|тунец|сельд/, '🐟'], [/кревет/, '🍤'], [/кур|индейк|котлет/, '🍗'],
      [/каш|овсян|гречк|плов|рис/, '🥣'], [/смузи|коктейл/, '🥤'], [/сырник|блин|оладь/, '🥞'],
      [/омлет|яичниц|шакшук|яйц/, '🍳'], [/тост|бутерброд/, '🥪'], [/творог|йогурт/, '🥛'],
      [/хумус/, '🫘'], [/яблок|фрукт|ягод/, '🍎'], [/шарик|конфет|десерт|шоколад/, '🍫'], [/рагу|овощ/, '🥘'], [/пицц/, '🍕']
    ];
    function placeholder(r) {
      var t = (r.title || '').toLowerCase();
      var emoji = null;
      for (var i = 0; i < EMOJI_RULES.length; i++) if (EMOJI_RULES[i][0].test(t)) { emoji = EMOJI_RULES[i][1]; break; }
      var meal = (r.meals || [])[0] || 'lunch';
      if (!emoji) emoji = { breakfast: '🍳', lunch: '🍲', dinner: '🍽️', snack: '🍎' }[meal] || '🍽️';
      return { emoji: emoji, meal: meal };
    }
    return { all: all, ready: ready, drafts: drafts, upsert: upsert, remove: remove, restore: restore, allTags: allTags, query: query,
      containsProduct: containsProduct, compressImage: compressImage, placeholder: placeholder };
  })();
  Foodly.Recipes = Recipes;

  /* =======================================================================
   * Shopping — агрегация позиций, единицы, источники
   * ======================================================================= */
  var Shopping = (function () {
    var TO_TASTE = { 'по вкусу': true, 'щепотка': true };

    /* Приводим к базовой единице: г / мл / шт (ложки — в граммы, если известен вес) */
    function toBase(amount, unit, product) {
      amount = Number(amount) || 0;
      if (TO_TASTE[unit]) return { amount: 0, unit: 'по вкусу' };
      if (unit === 'кг') return { amount: amount * 1000, unit: 'г' };
      if (unit === 'л') return { amount: amount * 1000, unit: 'мл' };
      if ((unit === 'ст. л.' || unit === 'ч. л.') && product && product.units && product.units[unit]) {
        if (product.units['мл']) return { amount: amount * product.units[unit] / product.units['мл'], unit: 'мл' };
        return { amount: amount * product.units[unit], unit: 'г' };
      }
      return { amount: amount, unit: unit };
    }
    /* Перевод между г / мл / шт через справочник; null — если невозможно */
    function convert(amount, from, to, product) {
      if (from === to) return amount;
      if (!product) return null;
      var g = Nutrition.toGrams(amount, from, product);
      if (g.status !== 'ok') return null;
      var u = product.units || {};
      if (to === 'г') return g.grams;
      if (to === 'мл') return u['мл'] ? g.grams / u['мл'] : null;
      if (to === 'шт' || to === 'ст. л.' || to === 'ч. л.') return u[to] ? g.grams / u[to] : null;
      return null;
    }
    function keyOf(it) { return it.productId ? 'p:' + it.productId : 'n:' + U.norm(it.name); }

    function formatQty(amount, unit) {
      if (unit === 'по вкусу') return 'по вкусу';
      amount = Number(amount) || 0;
      if (unit === 'г' && amount >= 1000) return U.fmt(amount / 1000, 2) + ' кг';
      if (unit === 'мл' && amount >= 1000) return U.fmt(amount / 1000, 2) + ' л';
      if (unit === 'г' || unit === 'мл') {
        var r = amount >= 100 ? Math.round(amount / 5) * 5 : Math.round(amount);
        return U.fmt(Math.max(r, amount > 0 ? 1 : 0)) + ' ' + unit;
      }
      if (unit === 'шт') return U.fmt(Math.ceil(amount * 2 - 1e-9) / 2, 1) + ' шт';
      return U.fmt(amount, 1) + ' ' + unit;
    }
    function addRef(item, ref) {
      if (!ref) return;
      item.sourceRefs = item.sourceRefs || [];
      var ex = item.sourceRefs.filter(function (r) { return r.type === ref.type && r.id === ref.id; })[0];
      if (ex) ex.portions = U.round((ex.portions || 0) + (ref.portions || 0), 2);
      else item.sourceRefs.push(U.clone(ref));
    }
    /* Добавить позицию с агрегацией в незакупленные */
    function addItem(list, raw, ref) {
      var product = raw.productId ? DB.product(raw.productId) : null;
      var base = toBase(raw.amount, raw.unit, product);
      var item = {
        id: U.uid('s'), name: product ? product.name : String(raw.name || '').trim(),
        productId: product ? product.id : null, amount: base.amount, unit: base.unit,
        category: raw.category || (product ? product.category : 'other'),
        checked: false, source: raw.source || 'manual', sourceRefs: []
      };
      var key = keyOf(item);
      var same = list.filter(function (x) { return !x.checked && keyOf(x) === key; });
      if (item.unit === 'по вкусу') {
        if (same.length) { addRef(same[0], ref); return same[0]; }
        addRef(item, ref); list.push(item); return item;
      }
      for (var i = 0; i < same.length; i++) {
        var ex = same[i];
        if (ex.unit === 'по вкусу') {
          ex.amount = item.amount; ex.unit = item.unit; addRef(ex, ref); return ex;
        }
        var c = convert(item.amount, item.unit, ex.unit, product);
        if (c != null) { ex.amount = U.round(ex.amount + c, 3); addRef(ex, ref); return ex; }
        var back = convert(ex.amount, ex.unit, item.unit, product);
        if (back != null) { ex.amount = U.round(back + item.amount, 3); ex.unit = item.unit; addRef(ex, ref); return ex; }
      }
      addRef(item, ref);
      list.push(item);
      return item;
    }
    function addRecipe(recipe, portions, source, planRef) {
      var mult = portions / Math.max(1, recipe.servings);
      var ref = planRef || { type: 'recipe', id: recipe.id, title: recipe.title, portions: portions };
      recipe.ingredients.forEach(function (ing) {
        var p = DB.product(ing.productId);
        if (!p) return;
        addItem(DB.state.shopping, { productId: p.id, amount: (Number(ing.amount) || 0) * mult, unit: ing.unit, source: source || 'recipe' }, ref);
      });
    }
    function grouped(list) {
      var cats = DB.state.settings.categories;
      var known = {};
      cats.forEach(function (c) { known[c.id] = true; });
      var groups = cats.map(function (c) { return { id: c.id, name: c.name, items: [] }; });
      var byId = {};
      groups.forEach(function (g) { byId[g.id] = g; });
      list.forEach(function (it) { (byId[known[it.category] ? it.category : 'other'] || groups[groups.length - 1]).items.push(it); });
      groups.forEach(function (g) {
        g.items.sort(function (a, b) {
          if (a.checked !== b.checked) return a.checked ? 1 : -1;
          return a.name.localeCompare(b.name, 'ru');
        });
      });
      return groups.filter(function (g) { return g.items.length; });
    }
    function refsLabel(it) {
      var refs = it.sourceRefs || [];
      if (!refs.length) return it.source === 'manual' ? '' : '';
      return refs.map(function (r) {
        if (r.type === 'plan') return 'меню: ' + r.title;
        return r.title + (r.portions ? ' (' + U.fmt(r.portions, 1) + ' ' + U.plural(Math.ceil(r.portions), 'порция', 'порции', 'порций') + ')' : '');
      }).join(', ');
    }
    return { toBase: toBase, convert: convert, addItem: addItem, addRecipe: addRecipe, grouped: grouped, formatQty: formatQty, refsLabel: refsLabel, keyOf: keyOf };
  })();
  Foodly.Shopping = Shopping;

  /* =======================================================================
   * Fridge — что есть дома и подбор рецептов, для которых меньше всего докупать
   *   item: {id, productId, amount|null, unit (г/мл/шт…), addedAt, expires|null}
   *   amount = null — «есть», количество не важно
   * ======================================================================= */
  var Fridge = (function () {
    var MAX_MISSING = 3;
    var EPS = 1e-6;
    function all() { return DB.state.fridge; }
    function byProduct(pid) { return all().filter(function (x) { return x.productId === pid; })[0] || null; }
    function pantry() { return (DB.state.settings && DB.state.settings.pantry) || { categories: [], products: [] }; }
    /* Продукт «всегда есть дома» — холодильник его не требует */
    function isPantry(pid) {
      var pt = pantry();
      if (pt.products.indexOf(pid) >= 0) return true;
      var p = DB.product(pid);
      return !!(p && pt.categories.indexOf(p.category) >= 0);
    }
    function normAmount(amount, unit, product) {
      if (amount == null || amount === '' || unit === 'по вкусу' || unit === 'щепотка') return { amount: null, unit: unit === 'по вкусу' || unit === 'щепотка' ? 'г' : (unit || 'г') };
      var b = Shopping.toBase(amount, unit, product);
      return { amount: U.round(b.amount, 3), unit: b.unit };
    }
    /* Добавить продукт; если он уже есть — суммируем (через граммы/мл/шт, если единицы разные) */
    function add(raw) {
      var p = DB.product(raw.productId); if (!p) return null;
      var n = normAmount(raw.amount, raw.unit, p);
      var ex = byProduct(p.id);
      if (!ex) {
        ex = { id: U.uid('fr'), productId: p.id, amount: n.amount, unit: n.unit, addedAt: Date.now(), expires: raw.expires || null };
        all().push(ex);
        return ex;
      }
      if (raw.expires && (!ex.expires || raw.expires < ex.expires)) ex.expires = raw.expires;
      if (n.amount == null) return ex;                       // «есть» ничего не меняет в количестве
      if (ex.amount == null) { ex.amount = n.amount; ex.unit = n.unit; return ex; }
      var c = Shopping.convert(n.amount, n.unit, ex.unit, p);
      if (c != null) { ex.amount = U.round(ex.amount + c, 3); return ex; }
      var back = Shopping.convert(ex.amount, ex.unit, n.unit, p);
      if (back != null) { ex.amount = U.round(back + n.amount, 3); ex.unit = n.unit; return ex; }
      ex.amount = n.amount; ex.unit = n.unit;                  // несравнимые единицы — берём новое значение
      return ex;
    }
    function remove(id) {
      var i = all().findIndex(function (x) { return x.id === id; });
      if (i < 0) return null;
      return { item: all().splice(i, 1)[0], index: i };
    }
    function snapshot() { return U.clone(all()); }
    function restore(snap) { DB.state.fridge = snap; DB.save('fridge'); }

    /* Сколько продукта в холодильнике в единицах `unit`: число, Infinity («есть» без количества) или null (не сравнить) */
    function availableIn(item, unit, product) {
      if (!item) return 0;
      if (item.amount == null) return Infinity;
      if (item.unit === unit) return item.amount;
      return Shopping.convert(item.amount, item.unit, unit, product);
    }
    /* Сопоставление рецепта с холодильником. mult — множитель порций (1 = как в рецепте).
       → {have:[], missing:[], pantry:[], total, score} */
    function match(recipe, mult) {
      mult = mult == null ? 1 : mult;
      var have = [], missing = [], pantryList = [];
      var used = {};   // сколько уже «потратили» на предыдущие строки рецепта: pid → {unit, amount}
      var seen = {};
      (recipe.ingredients || []).forEach(function (ing) {
        var p = DB.product(ing.productId); if (!p) return;
        if (isPantry(p.id)) { if (!seen['p:' + p.id]) pantryList.push(p); seen['p:' + p.id] = true; return; }
        var item = byProduct(p.id);
        var need = Shopping.toBase((Number(ing.amount) || 0) * mult, ing.unit, p);
        var entry = { productId: p.id, name: p.name, category: p.category, amount: need.amount, unit: need.unit, expires: item ? item.expires : null };
        if (!item) { missing.push(entry); return; }
        if (need.unit === 'по вкусу' || item.amount == null) { have.push(entry); return; }
        var avail = availableIn(item, need.unit, p);
        if (avail == null) { have.push(entry); return; }      // единицы не сравнить — считаем, что есть
        var u = used[p.id]; var spent = u && u.unit === need.unit ? u.amount : 0;
        var left = avail - spent;
        used[p.id] = { unit: need.unit, amount: spent + need.amount };
        if (left + EPS >= need.amount) { have.push(entry); return; }
        entry.partial = true; entry.haveAmount = Math.max(0, left); entry.shortfall = need.amount - Math.max(0, left);
        missing.push(entry);
      });
      // одна и та же позиция несколько раз — в списках показываем один раз
      function uniq(list) { var s = {}; return list.filter(function (x) { if (s[x.productId]) return false; s[x.productId] = true; return true; }); }
      var missingIds = {}; missing.forEach(function (x) { missingIds[x.productId] = true; });
      have = uniq(have.filter(function (x) { return !missingIds[x.productId]; }));
      missing = uniq(missing);
      var total = have.length + missing.length;
      return { have: have, missing: missing, pantry: pantryList, total: total, score: total ? have.length / total : 0 };
    }
    function daysLeft(iso) {
      if (!iso) return null;
      var t = U.todayISO(); var a = iso.split('-'), b = t.split('-');
      return Math.round((new Date(+a[0], +a[1] - 1, +a[2]) - new Date(+b[0], +b[1] - 1, +b[2])) / 86400000);
    }
    /* Подходящие рецепты: только готовые; с ≥1 продуктом из холодильника и ≤3 недостающими.
       opts: {meal, respect} — respect: учитывать диеты и исключённые продукты из «Параметров меню» */
    function suggestions(opts) {
      opts = opts || {};
      if (!all().length) return [];
      var rs = DB.state.settings.restrictions;
      var ex = opts.respect ? rs.excluded : [], diets = opts.respect ? (rs.diets || []) : [];
      return Recipes.ready().filter(function (r) {
        if (opts.meal && (r.meals || []).indexOf(opts.meal) < 0) return false;
        if (diets.length && !Diets.fitsAll(r, diets)) return false;
        return !Recipes.containsProduct(r, ex);
      }).map(function (r) {
        var m = match(r);
        // скоро испортится — такие рецепты чуть выше при прочих равных
        m.urgent = m.have.filter(function (x) { var d = daysLeft(x.expires); return d != null && d <= 2; }).length;
        return { recipe: r, match: m };
      }).filter(function (x) { return x.match.have.length > 0 && x.match.missing.length <= MAX_MISSING; })
        .sort(function (a, b) {
          var am = a.match.missing.length, bm = b.match.missing.length;
          if (am !== bm) return am - bm;
          if (Math.abs(a.match.score - b.match.score) > EPS) return b.match.score - a.match.score;
          if (a.match.urgent !== b.match.urgent) return b.match.urgent - a.match.urgent;
          if (a.match.have.length !== b.match.have.length) return b.match.have.length - a.match.have.length;
          return a.recipe.title.localeCompare(b.recipe.title, 'ru');
        });
    }
    /* «Докупить недостающее»: в список покупок только то, чего нет (или не хватает) */
    function buyMissing(recipe, m, mult) {
      m = m || match(recipe, mult);
      var ref = { type: 'recipe', id: recipe.id, title: recipe.title, portions: U.round(recipe.servings * (mult == null ? 1 : mult), 2) };
      m.missing.forEach(function (x) {
        Shopping.addItem(DB.state.shopping, { productId: x.productId, amount: x.partial ? x.shortfall : x.amount, unit: x.unit, source: 'fridge' }, ref);
      });
      return m.missing.length;
    }
    /* «Приготовлено»: списать ингредиенты из холодильника. Позиции без количества не трогаем. → число изменённых позиций */
    function consume(recipe, mult) {
      mult = mult == null ? 1 : mult;
      var changed = {};
      (recipe.ingredients || []).forEach(function (ing) {
        var p = DB.product(ing.productId); if (!p || isPantry(p.id)) return;
        var item = byProduct(p.id); if (!item || item.amount == null) return;
        var need = Shopping.toBase((Number(ing.amount) || 0) * mult, ing.unit, p);
        if (need.unit === 'по вкусу') return;
        var c = item.unit === need.unit ? need.amount : Shopping.convert(need.amount, need.unit, item.unit, p);
        if (c == null) return;
        item.amount = U.round(item.amount - c, 3);
        changed[item.id] = true;
      });
      DB.state.fridge = all().filter(function (x) { return !(changed[x.id] && x.amount != null && x.amount <= EPS); });
      return Object.keys(changed).length;
    }
    /* Купленное из списка покупок → в холодильник (суммируя). Позиции без продукта из справочника пропускаем */
    function fromShopping() {
      var moved = 0, skipped = [], movedIds = {};
      DB.state.shopping.forEach(function (it) {
        if (!it.checked) return;
        var p = it.productId ? DB.product(it.productId) : DB.findProductByName(it.name);
        if (!p) { skipped.push(it.name); return; }
        add({ productId: p.id, amount: it.unit === 'по вкусу' ? null : it.amount, unit: it.unit });
        movedIds[it.id] = true; moved++;
      });
      if (moved) DB.state.shopping = DB.state.shopping.filter(function (it) { return !movedIds[it.id]; });
      return { moved: moved, skipped: skipped };
    }
    function qtyLabel(item) {
      if (item.amount == null) return 'есть';
      return Shopping.formatQty(item.amount, item.unit);
    }
    function grouped() {
      var list = all().map(function (x) {
        var p = DB.product(x.productId);
        return { item: x, name: p ? p.name : '(продукт удалён)', category: p ? p.category : 'other', checked: false };
      });
      return Shopping.grouped(list);
    }
    return { all: all, byProduct: byProduct, isPantry: isPantry, add: add, remove: remove, snapshot: snapshot, restore: restore,
      match: match, suggestions: suggestions, buyMissing: buyMissing, consume: consume, fromShopping: fromShopping,
      qtyLabel: qtyLabel, grouped: grouped, daysLeft: daysLeft, MAX_MISSING: MAX_MISSING };
  })();
  Foodly.Fridge = Fridge;

  /* =======================================================================
   * Planner — детерминированный подбор плана питания на 7 дней
   * ======================================================================= */
  var Planner = (function () {
    var SLOT_SHARES = {
      3: [['breakfast', 0.30], ['lunch', 0.40], ['dinner', 0.30]],
      4: [['breakfast', 0.25], ['lunch', 0.35], ['snack', 0.10], ['dinner', 0.30]],
      5: [['breakfast', 0.20], ['snack', 0.10], ['lunch', 0.35], ['snack', 0.10], ['dinner', 0.25]]
    };
    var PORTIONS = [0.5, 1, 1.5, 2, 2.5];
    var MAX_PER_WEEK = 2;
    var DAYS = 7;
    var ATTEMPTS = 30;

    /* mulberry32 — быстрый seeded PRNG */
    function mulberry32(a) {
      a = a >>> 0;
      return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        var t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function daySeed(seed, i) { return (Math.imul((seed >>> 0) ^ 0x9E3779B9, i + 1) + i * 1013904223) >>> 0; }
    function newSeed() { return (Math.floor(Math.random() * 4294967295)) >>> 0; }

    function context(cfg) {
      var excluded = (cfg.restrictions && cfg.restrictions.excluded) || [];
      var diets = (cfg.restrictions && cfg.restrictions.diets) || [];
      var info = {};
      var allowed = Recipes.ready().filter(function (r) {
        if (Recipes.containsProduct(r, excluded)) return false;
        if (!Diets.fitsAll(r, diets)) return false;
        var ps = Nutrition.perServing(r);
        if (!(ps.kcal > 0)) return false;
        var b = Nutrition.badges(ps);
        info[r.id] = { ps: ps, protein: b.some(function (x) { return x.id === 'protein'; }), fiber: b.some(function (x) { return x.id === 'fiber'; }) };
        return true;
      });
      var pool = {};
      Models.MEALS.forEach(function (m) {
        pool[m.id] = allowed.filter(function (r) { return (r.meals || []).indexOf(m.id) >= 0; });
      });
      var shares = SLOT_SHARES[cfg.mealsPerDay] || SLOT_SHARES[3];
      return { cfg: cfg, allowed: allowed, pool: pool, info: info, shares: shares, targets: cfg.targets, keto: cfg.macroMode === 'keto' };
    }

    function mealNutrition(ctx, meal) {
      var inf = ctx.info[meal.recipeId];
      if (!inf) {
        var r = DB.recipe(meal.recipeId);
        if (!r) return Nutrition.empty();
        return Nutrition.scale(Nutrition.perServing(r), meal.portions);
      }
      return Nutrition.scale(inf.ps, meal.portions);
    }
    function dayTotals(ctx, meals) {
      return meals.reduce(function (acc, m) { return m && m.recipeId ? Nutrition.add(acc, mealNutrition(ctx, m)) : acc; }, Nutrition.empty());
    }
    function macroDev(t, target) {
      var d = 0, n = 0;
      ['protein', 'fat', 'carbs'].forEach(function (k) {
        if (target[k] > 0) { d += Math.abs(t[k] - target[k]) / target[k]; n++; }
      });
      return n ? d / n : 0;
    }
    function kcalDev(t, target) { return target.kcal > 0 ? (t.kcal - target.kcal) / target.kcal : 0; }
    /* Кето: углеводы — жёсткий потолок (превышение штрафуется сильно), жиры — не меньше 70% калорий */
    var KETO_FAT_MIN = 70;
    function ketoPenalty(t, target) {
      var over = target.carbs > 0 ? Math.max(0, t.carbs - target.carbs) / target.carbs : 0;
      var fat = Nutrition.macroPct(t).fat;
      return over * 2 + Math.max(0, KETO_FAT_MIN - fat) / 100 * 6;
    }
    function objective(t, target, keto) {
      var kd = Math.abs(kcalDev(t, target));
      return kd + Math.max(0, kd - 0.04) * 4 + (keto ? 0.5 : 0.25) * macroDev(t, target) + (keto ? ketoPenalty(t, target) : 0);
    }
    function bestPortion(kcal, slotKcal) {
      var best = PORTIONS[0], bd = Infinity;
      PORTIONS.forEach(function (p) { var d = Math.abs(kcal * p - slotKcal); if (d < bd - 1e-9) { bd = d; best = p; } });
      return best;
    }
    /* Донастройка порций дня: шаг ±0,5, пока улучшается целевая функция */
    function tune(ctx, meals) {
      for (var iter = 0; iter < 60; iter++) {
        var cur = objective(dayTotals(ctx, meals), ctx.targets, ctx.keto);
        var bestGain = 1e-6, bestMove = null;
        meals.forEach(function (m, i) {
          if (!m || !m.recipeId || m.locked) return;
          [-0.5, 0.5].forEach(function (d) {
            var np = U.round(m.portions + d, 1);
            if (np < PORTIONS[0] || np > PORTIONS[PORTIONS.length - 1]) return;
            var old = m.portions; m.portions = np;
            var val = objective(dayTotals(ctx, meals), ctx.targets, ctx.keto);
            m.portions = old;
            if (cur - val > bestGain) { bestGain = cur - val; bestMove = [i, np]; }
          });
        });
        if (!bestMove) break;
        meals[bestMove[0]].portions = bestMove[1];
      }
    }
    function candidatesFor(ctx, slot, usedToday, usage) {
      var relax = null;
      // кето: подходящих блюд мало, поэтому лучше повторить жирное блюдо 3 раза за неделю, чем добирать нежирным
      var maxWeek = ctx.keto ? MAX_PER_WEEK + 1 : MAX_PER_WEEK;
      var c = ctx.pool[slot].filter(function (r) { return !usedToday[r.id] && (usage[r.id] || 0) < maxWeek; });
      if (!c.length) { relax = 'repeat'; c = ctx.pool[slot].filter(function (r) { return !usedToday[r.id]; }); }
      if (!c.length) { relax = 'tag'; c = ctx.allowed.filter(function (r) { return !usedToday[r.id] && (usage[r.id] || 0) < maxWeek; }); }
      if (!c.length) { relax = 'tag'; c = ctx.allowed.filter(function (r) { return !usedToday[r.id]; }); }
      if (!c.length) { relax = 'tag'; c = ctx.allowed.slice(); }
      return { list: c, relax: relax };
    }
    function buildDay(ctx, date, seed, usage) {
      var best = null;
      var t = ctx.targets;
      var pref = ctx.cfg.restrictions || {};
      for (var attempt = 0; attempt < ATTEMPTS; attempt++) {
        var rng = mulberry32((seed + Math.imul(attempt, 7919)) >>> 0);
        var used = {}, meals = [], relaxed = {};
        var noise = attempt === 0 ? 0.25 : 0.25 + attempt * 0.03;
        ctx.shares.forEach(function (sh) {
          var slot = sh[0], share = sh[1];
          var slotT = { kcal: t.kcal * share, protein: t.protein * share, fat: t.fat * share, carbs: t.carbs * share };
          var c = candidatesFor(ctx, slot, used, usage);
          if (c.relax) relaxed[slot] = c.relax;
          if (!c.list.length) { meals.push({ slot: slot, recipeId: null, portions: 1 }); return; }
          var bestR = null, bestS = Infinity, bestP = 1;
          c.list.forEach(function (r) {
            var inf = ctx.info[r.id];
            var p = bestPortion(inf.ps.kcal, slotT.kcal);
            var got = Nutrition.scale(inf.ps, p);
            var s = Math.abs(got.kcal - slotT.kcal) / slotT.kcal + (ctx.keto ? 0.6 : 0.35) * macroDev(got, slotT) + (ctx.keto ? ketoPenalty(got, slotT) : 0);
            s += (usage[r.id] || 0) * 0.12;
            if (pref.moreProtein && inf.protein) s -= 0.15;
            if (pref.moreFiber && inf.fiber) s -= 0.15;
            s += rng() * noise;
            if (s < bestS) { bestS = s; bestR = r; bestP = p; }
          });
          used[bestR.id] = true;
          meals.push({ slot: slot, recipeId: bestR.id, portions: bestP });
        });
        tune(ctx, meals);
        var tot = dayTotals(ctx, meals);
        var dev = Math.abs(kcalDev(tot, t));
        var score = objective(tot, t, ctx.keto) + Object.keys(relaxed).length * 0.05;
        if (!best || score < best.score) best = { meals: meals, score: score, dev: dev, relaxed: relaxed, tot: tot };
        if (dev <= 0.05 && macroDev(tot, t) <= 0.2 && (!ctx.keto || ketoPenalty(tot, t) < 0.01)) break;
      }
      return { date: date, seed: seed, meals: best.meals, warning: warningFor(ctx, best) };
    }
    function warningFor(ctx, best) {
      var msgs = [];
      var relaxedSlots = Object.keys(best.relaxed);
      if (!ctx.allowed.length) return 'Нет подходящих рецептов. Добавьте рецепты' + ((ctx.cfg.restrictions && (ctx.cfg.restrictions.diets || []).length) ? ', выберите меньше диет' : '') + ' или разрешите больше продуктов в параметрах меню.';
      var ketoMsg = null;
      if (ctx.keto) {
        var pc = Nutrition.macroPct(best.tot);
        if (best.tot.carbs > ctx.targets.carbs * 1.1) ketoMsg = 'углеводов ' + U.fmt(best.tot.carbs) + ' г при норме ' + ctx.targets.carbs + ' г — для кето это много, добавьте кето-рецепты';
        else if (pc.fat < KETO_FAT_MIN - 5) ketoMsg = 'жиры дают только ' + U.fmt(pc.fat) + '% калорий (для кето нужно 70–75%) — добавьте более жирные кето-рецепты';
      }
      if (best.dev <= 0.10 && !relaxedSlots.length && !ketoMsg) return null;
      relaxedSlots.forEach(function (s) {
        var name = Models.mealName(s).toLowerCase();
        var more = (ctx.cfg.restrictions && (ctx.cfg.restrictions.diets || []).length) ? 'добавьте рецепты под выбранную диету' : 'добавьте рецепты или разрешите больше продуктов';
        if (best.relaxed[s] === 'tag') msgs.push('нет рецептов для приёма пищи «' + name + '» — отметьте этот приём пищи в подходящих рецептах или ' + more.replace('добавьте', 'добавьте новые'));
        else msgs.push('на «' + name + '» мало рецептов, поэтому блюда повторяются чаще двух раз в неделю — ' + more);
      });
      if (best.dev > 0.10) {
        var over = best.tot.kcal > ctx.targets.kcal;
        msgs.unshift('день отличается от нормы на ' + U.fmt(best.dev * 100) + '%: ' + (over
          ? 'блюда слишком калорийные даже в половине порции — добавьте лёгкие рецепты'
          : 'калорий не хватает даже с 2,5 порциями — добавьте более сытные рецепты или разрешите больше продуктов'));
      }
      if (ketoMsg) msgs.push(ketoMsg);
      var s = msgs.join('; ');
      return s.charAt(0).toUpperCase() + s.slice(1) + '.';
    }
    function snapshotCfg(settings) {
      return {
        targets: U.clone(settings.targets && settings.targets.kcal > 0 ? settings.targets : Nutrition.targetsFor(settings)), mealsPerDay: settings.mealsPerDay, people: settings.people,
        restrictions: U.clone(settings.restrictions), macroMode: Nutrition.macroMode(settings)
      };
    }
    function usageOf(days, skipIndex) {
      var u = {};
      days.forEach(function (d, i) {
        if (i === skipIndex || !d) return;
        d.meals.forEach(function (m) { if (m.recipeId) u[m.recipeId] = (u[m.recipeId] || 0) + 1; });
      });
      return u;
    }
    /* Полная генерация: одинаковые seed + входные данные → одинаковый план */
    function generate(settings, startDate, seed) {
      seed = seed == null ? newSeed() : seed >>> 0;
      var cfg = snapshotCfg(settings);
      var ctx = context(cfg);
      var days = [];
      for (var i = 0; i < DAYS; i++) {
        var usage = usageOf(days, -1);
        days.push(buildDay(ctx, U.addDays(startDate, i), daySeed(seed, i), usage));
      }
      return { id: U.uid('plan'), createdAt: Date.now(), seed: seed, startDate: startDate, settings: cfg, days: days, savedAt: null };
    }
    function regenerateDay(plan, idx, seed) {
      var ctx = context(plan.settings);
      var usage = usageOf(plan.days, idx);
      seed = seed == null ? newSeed() : seed;
      plan.days[idx] = buildDay(ctx, plan.days[idx].date, seed >>> 0, usage);
      plan.savedAt = null;
      return plan.days[idx];
    }
    function evaluateDay(plan, idx) {
      var ctx = context(plan.settings);
      var d = plan.days[idx];
      var tot = dayTotals(ctx, d.meals);
      var dev = kcalDev(tot, plan.settings.targets);
      var ad = Math.abs(dev);
      return { totals: tot, dev: dev, level: ad <= 0.10 ? 'ok' : ad <= 0.20 ? 'warn' : 'bad' };
    }
    /* Кандидаты на замену: сортировка по итоговому отклонению дня */
    function replacementCandidates(plan, dayIdx, mealIdx, showAll) {
      var ctx = context(plan.settings);
      var day = plan.days[dayIdx];
      var meal = day.meals[mealIdx];
      var usage = usageOf(plan.days, dayIdx);
      var list = showAll ? ctx.allowed : ctx.pool[meal.slot];
      var others = day.meals.filter(function (m, i) { return i !== mealIdx; });
      var otherTot = dayTotals(ctx, others);
      var t = plan.settings.targets;
      return list.filter(function (r) { return r.id !== meal.recipeId; }).map(function (r) {
        var inf = ctx.info[r.id];
        var bestP = 1, bestV = Infinity, bestTot = null;
        PORTIONS.forEach(function (p) {
          var tot = Nutrition.add(otherTot, Nutrition.scale(inf.ps, p));
          var v = objective(tot, t, ctx.keto);
          if (v < bestV - 1e-9) { bestV = v; bestP = p; bestTot = tot; }
        });
        var sameDay = others.some(function (m) { return m.recipeId === r.id; });
        var weekCount = usage[r.id] || 0;
        return { recipe: r, portions: bestP, dayKcal: bestTot.kcal, dev: kcalDev(bestTot, t), score: bestV + (sameDay ? 1 : 0) + (weekCount >= MAX_PER_WEEK ? 0.5 : 0),
          sameDay: sameDay, weekCount: weekCount, kcal: inf.ps.kcal * bestP };
      }).sort(function (a, b) { return a.score - b.score; });
    }
    function replaceMeal(plan, dayIdx, mealIdx, recipeId, portions) {
      var m = plan.days[dayIdx].meals[mealIdx];
      m.recipeId = recipeId; m.portions = portions;
      plan.days[dayIdx].warning = null;
      plan.savedAt = null;
    }
    function weekCounts(plan) { return usageOf(plan.days, -1); }
    return { generate: generate, regenerateDay: regenerateDay, evaluateDay: evaluateDay, replacementCandidates: replacementCandidates,
      replaceMeal: replaceMeal, dayTotals: function (plan, idx) { return evaluateDay(plan, idx).totals; }, mealNutrition: function (plan, m) { return mealNutrition(context(plan.settings), m); },
      weekCounts: weekCounts, mulberry32: mulberry32, newSeed: newSeed, PORTIONS: PORTIONS, SLOT_SHARES: SLOT_SHARES, MAX_PER_WEEK: MAX_PER_WEEK };
  })();
  Foodly.Planner = Planner;

  /* =======================================================================
   * Photos — фото рецептов в IndexedDB (много места, Blob вместо base64)
   *   recipe.photoId  — ссылка на запись в IndexedDB (локальная копия)
   *   recipe.photoUrl — исходная ссылка, если фото добавлено по URL
   *   recipe.photo    — запасной вариант (data: URL в localStorage), только если IndexedDB недоступна
   * ======================================================================= */
  var PhotoStore = (function () {
    var DB_NAME = 'foodly', STORE = 'photos', VERSION = 1;
    var dbp = null, urls = {}, sizes = {}, available = false;

    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        if (!global.indexedDB) { reject(new Error('IndexedDB недоступна')); return; }
        var req;
        try { req = global.indexedDB.open(DB_NAME, VERSION); } catch (e) { reject(e); return; }
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('IndexedDB error')); };
        req.onblocked = function () { reject(new Error('IndexedDB заблокирована другой вкладкой')); };
      });
      dbp.catch(function () { dbp = null; });
      return dbp;
    }
    /* Выполнить операцию в транзакции; результат запроса отдаём после commit */
    function tx(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(STORE, mode);
          var r = fn(t.objectStore(STORE));
          t.oncomplete = function () { resolve(r && typeof r === 'object' && 'result' in r ? r.result : r); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () {
            var e = t.error;
            if (e && e.name === 'QuotaExceededError') reject(new Error('Не хватает места для фото на устройстве.'));
            else reject(e || new Error('Транзакция прервана'));
          };
        });
      });
    }
    function track(rec) {
      if (urls[rec.id]) URL.revokeObjectURL(urls[rec.id]);
      urls[rec.id] = URL.createObjectURL(rec.blob);
      sizes[rec.id] = rec.blob.size;
    }
    function untrack(id) {
      if (urls[id]) URL.revokeObjectURL(urls[id]);
      delete urls[id]; delete sizes[id];
    }
    /* Загружаем все фото и готовим objectURL — чтобы рендер был синхронным */
    function init() {
      var timeout = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 3000); });
      return Promise.race([tx('readonly', function (st) { return st.getAll(); }), timeout]).then(function (all) {
        (all || []).forEach(function (rec) { if (rec && rec.blob) track(rec); });
        available = true;
        return true;
      }).catch(function (e) {
        available = false;
        console.warn('[Foodly] IndexedDB недоступна, фото будут храниться в localStorage', e);
        return false;
      });
    }
    function putRecord(rec) {
      return tx('readwrite', function (st) { return st.put(rec); }).then(function () { track(rec); return rec.id; });
    }
    function put(blob, meta) {
      meta = meta || {};
      var rec = { id: meta.id || U.uid('ph'), blob: blob, type: blob.type || 'image/jpeg', url: meta.url || null,
        source: meta.source || 'upload', createdAt: Date.now(), size: blob.size };
      return putRecord(rec);
    }
    function remove(id) {
      if (!id) return Promise.resolve();
      untrack(id);
      return tx('readwrite', function (st) { return st.delete(id); }).catch(function () {});
    }
    function clear() {
      Object.keys(urls).forEach(untrack);
      return tx('readwrite', function (st) { return st.clear(); }).catch(function () {});
    }
    function all() { return tx('readonly', function (st) { return st.getAll(); }).then(function (a) { return a || []; }); }
    function url(id) { return id ? urls[id] || null : null; }
    function has(id) { return !!urls[id]; }
    function stats() {
      var ids = Object.keys(sizes);
      return { count: ids.length, bytes: ids.reduce(function (s, id) { return s + sizes[id]; }, 0) };
    }
    function referencedIds() {
      var ref = {};
      DB.state.recipes.forEach(function (r) { if (r.photoId) ref[r.photoId] = true; });
      return ref;
    }
    /* Сборка мусора: удаляем фото, на которые не ссылается ни один рецепт */
    function gc(keep) {
      if (!available) return Promise.resolve({ count: 0, bytes: 0 });
      // Страховка: если данные прочитались с ошибкой или рецептов нет совсем — ничего не удаляем
      if (Storage.readErrors() > 0 || !DB.state.recipes.length) return Promise.resolve({ count: 0, bytes: 0, skipped: true });
      var ref = referencedIds();
      (keep || []).forEach(function (id) { ref[id] = true; });
      var orphans = Object.keys(urls).filter(function (id) { return !ref[id]; });
      var bytes = orphans.reduce(function (s, id) { return s + (sizes[id] || 0); }, 0);
      return Promise.all(orphans.map(remove)).then(function () { return { count: orphans.length, bytes: bytes }; });
    }
    /* Висячие ссылки: рецепт ссылается на фото, которого нет в базе */
    function fixDangling() {
      if (!available) return 0;
      var n = 0;
      DB.state.recipes.forEach(function (r) {
        if (r.photoId && !urls[r.photoId]) { r.photoId = null; n++; }
      });
      if (n) DB.save('recipes');
      return n;
    }
    function dataURLToBlob(dataURL) {
      var m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(dataURL || '');
      if (!m) throw new Error('bad data url');
      var type = m[1] || 'application/octet-stream';
      var raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
      var arr = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      return new Blob([arr], { type: type });
    }
    function blobToDataURL(blob) {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(fr.error); };
        fr.readAsDataURL(blob);
      });
    }
    /* Переносим старые base64-фото из localStorage в IndexedDB */
    function migrateInline() {
      if (!available) return Promise.resolve(0);
      var list = DB.state.recipes.filter(function (r) { return typeof r.photo === 'string' && r.photo.indexOf('data:') === 0; });
      if (!list.length) return Promise.resolve(0);
      return Promise.all(list.map(function (r) {
        var blob;
        try { blob = dataURLToBlob(r.photo); } catch (e) { return null; }
        return put(blob, { source: 'upload' }).then(function (id) { r.photoId = id; r.photo = null; });
      })).then(function () { DB.save('recipes'); return list.length; }).catch(function (e) {
        console.warn('[Foodly] миграция фото не удалась', e); return 0;
      });
    }
    /* Уменьшенная копия Commons (/thumb/.../960px-Name) → оригинал; для остальных ссылок null */
    function originalOf(link) {
      var m = /^(https:\/\/upload\.wikimedia\.org\/wikipedia\/commons)\/thumb\/([0-9a-f]\/[0-9a-f]{2}\/[^/]+)\/\d+px-[^/]+$/.exec(link || '');
      return m ? m[1] + '/' + m[2] : null;
    }
    /* Пытаемся скачать фото по ссылке и сохранить сжатую копию (нужен CORS у сайта) */
    function fetchCopy(link) {
      function get(u) {
        var ctrl = global.AbortController ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
        return fetch(u, { mode: 'cors', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
          clearTimeout(timer);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.blob();
        }).then(function (blob) {
          if (!/^image\//.test(blob.type)) throw new Error('not an image');
          return Recipes.compressImage(blob, 800, 0.75);
        });
      }
      var orig = originalOf(link);
      return get(link).catch(function (e) { if (orig) return get(orig); throw e; });
    }
    /* Фоном сохраняем локальные копии фото-ссылок (по 2 одновременно), чтобы они были видны офлайн */
    var caching = false;
    function cacheRemote() {
      if (!available || caching || (global.navigator && navigator.onLine === false)) return Promise.resolve(0);
      var WEEK = 7 * 24 * 3600 * 1000, now = Date.now();
      var todo = DB.state.recipes.filter(function (r) {
        return r.photoUrl && !r.photoId && !r.photo && !(r.photoCopyFailedAt && now - r.photoCopyFailedAt < WEEK);
      });
      if (!todo.length) return Promise.resolve(0);
      caching = true;
      var done = 0, changed = false, i = 0;
      function next() {
        if (i >= todo.length) return Promise.resolve();
        var r = todo[i++], link = r.photoUrl;
        return fetchCopy(link).then(function (blob) {
          return put(blob, { source: 'url', url: link }).then(function (pid) {
            if (r.photoUrl === link && !r.photoId && DB.recipe(r.id) === r) { r.photoId = pid; delete r.photoCopyFailedAt; done++; changed = true; }
            else remove(pid);
          });
        }).catch(function () {
          if (global.navigator && navigator.onLine === false) return;
          r.photoCopyFailedAt = now; changed = true;   // сайт без CORS — показываем по ссылке, повторим через неделю
        }).then(next);
      }
      return Promise.all([next(), next()]).then(function () {
        caching = false;
        if (changed) DB.save('recipes');
        return done;
      }, function () { caching = false; return done; });
    }
    function estimate() {
      if (global.navigator && navigator.storage && navigator.storage.estimate) return navigator.storage.estimate().catch(function () { return null; });
      return Promise.resolve(null);
    }
    /* Просим браузер не удалять данные при нехватке места (Chrome/Firefox; на http(s)) */
    function persist() {
      if (!(global.navigator && navigator.storage && navigator.storage.persist)) return Promise.resolve(null);
      return navigator.storage.persisted().then(function (p) { return p ? true : navigator.storage.persist(); }).catch(function () { return null; });
    }
    return { init: init, put: put, putRecord: putRecord, remove: remove, clear: clear, all: all, url: url, has: has, stats: stats,
      gc: gc, fixDangling: fixDangling, migrateInline: migrateInline, fetchCopy: fetchCopy, cacheRemote: cacheRemote, originalOf: originalOf, dataURLToBlob: dataURLToBlob,
      blobToDataURL: blobToDataURL, estimate: estimate, persist: persist, isAvailable: function () { return available; } };
  })();
  Foodly.PhotoStore = PhotoStore;

  /* =======================================================================
   * PDF — экспорт списка покупок (jsPDF + шрифт Geist с кириллицей)
   * ======================================================================= */
  var PDF = (function () {
    var JSPDF_URLS = [
      'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.2/jspdf.umd.min.js'
    ];
    var FONT_SCRIPT = 'fonts/geist-pdf.js';
    var jsPdfPromise = null, fontPromise = null;

    function loadScript(src, timeoutMs) {
      return new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        var done = false;
        var t = setTimeout(function () { if (!done) { done = true; s.remove(); reject(new Error('timeout ' + src)); } }, timeoutMs || 15000);
        s.src = src; s.async = true;
        s.onload = function () { if (!done) { done = true; clearTimeout(t); resolve(); } };
        s.onerror = function () { if (!done) { done = true; clearTimeout(t); s.remove(); reject(new Error('load ' + src)); } };
        document.head.appendChild(s);
      });
    }
    function ensureJsPDF() {
      if (global.jspdf && global.jspdf.jsPDF) return Promise.resolve(global.jspdf.jsPDF);
      if (jsPdfPromise) return jsPdfPromise;
      jsPdfPromise = JSPDF_URLS.reduce(function (p, url) {
        return p.catch(function () { return loadScript(url); });
      }, Promise.reject(new Error('start'))).then(function () {
        if (!global.jspdf || !global.jspdf.jsPDF) throw new Error('jsPDF не инициализирован');
        return global.jspdf.jsPDF;
      }).catch(function (e) {
        jsPdfPromise = null;
        throw new Error('Не удалось загрузить библиотеку PDF (jsPDF). Проверьте подключение к интернету и попробуйте ещё раз.');
      });
      return jsPdfPromise;
    }
    /* Шрифт кешируется в памяти (Foodly.__pdfFonts), а при наличии SW — ещё и в его кеше */
    function ensureFonts() {
      if (Foodly.__pdfFonts) return Promise.resolve(Foodly.__pdfFonts);
      if (fontPromise) return fontPromise;
      fontPromise = loadScript(FONT_SCRIPT, 10000).then(function () {
        var f = Foodly.__pdfFonts;
        if (!f || !f.regular || !f.bold) throw new Error('bad font');
        return f;
      }).catch(function () {
        fontPromise = null;
        throw new Error('Не удалось загрузить шрифт с кириллицей для PDF. Без него текст будет нечитаемым, поэтому экспорт отменён.');
      });
      return fontPromise;
    }

    var PT = 0.3528; // 1 pt в мм
    function build(JsPDF, fonts, items, opts) {
      var doc = new JsPDF({ unit: 'mm', format: 'a5', orientation: 'portrait', compress: true });
      doc.addFileToVFS('Geist-Regular.ttf', fonts.regular);
      doc.addFont('Geist-Regular.ttf', 'Geist', 'normal');
      doc.addFileToVFS('Geist-Bold.ttf', fonts.bold);
      doc.addFont('Geist-Bold.ttf', 'Geist', 'bold');
      doc.setProperties({ title: 'Foodly! — Список покупок', creator: 'Foodly!' });

      var W = 148, H = 210, M = 12, CW = W - 2 * M;
      var BOTTOM = H - M - 6;
      var INK = [26, 26, 29], MUTED = [110, 110, 120], MINT = [62, 207, 142], LAV = [167, 139, 250];
      var y = M;

      function lh(pt) { return pt * PT * 1.28; }
      function newPage() { doc.addPage('a5', 'portrait'); y = M; }

      // Заголовок
      doc.setFont('Geist', 'bold'); doc.setFontSize(21); doc.setTextColor.apply(doc, INK);
      var titleLines = doc.splitTextToSize('Foodly! — Список покупок', CW);
      titleLines.forEach(function (l) { y += lh(21) * 0.85; doc.text(l, M, y); });
      y += 2;
      doc.setFont('Geist', 'normal'); doc.setFontSize(14); doc.setTextColor.apply(doc, MUTED);
      var d = new Date();
      var dateStr = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
      y += lh(14) * 0.85;
      doc.text(dateStr + ' · ' + items.length + ' ' + U.plural(items.length, 'позиция', 'позиции', 'позиций'), M, y);
      y += 3;
      doc.setDrawColor.apply(doc, LAV); doc.setLineWidth(0.6); doc.line(M, y, W - M, y);
      y += 5;

      var groups = Shopping.grouped(items);
      var ITEM_PT = 14, HEAD_PT = 17, BOX = 4.6, GAP_X = 3.2;

      function measureItem(it) {
        doc.setFont('Geist', 'normal'); doc.setFontSize(ITEM_PT);
        var qty = Shopping.formatQty(it.amount, it.unit);
        var qtyW = doc.getTextWidth(qty);
        var nameW = CW - BOX - GAP_X - qtyW - 4;
        var lines = doc.splitTextToSize(it.name, Math.max(30, nameW));
        return { qty: qty, lines: lines, h: lines.length * lh(ITEM_PT) + 2.4 };
      }
      function headH() { return lh(HEAD_PT) + 4.5; }
      function drawHead(name) {
        doc.setFont('Geist', 'bold'); doc.setFontSize(HEAD_PT); doc.setTextColor.apply(doc, INK);
        y += lh(HEAD_PT) * 0.8;
        doc.text(name, M, y);
        y += 1.6;
        doc.setDrawColor.apply(doc, MINT); doc.setLineWidth(0.8); doc.line(M, y, M + 18, y);
        y += 3;
      }
      function drawItem(it, m) {
        var top = y;
        var baseY = top + lh(ITEM_PT) * 0.78;
        doc.setDrawColor.apply(doc, INK); doc.setLineWidth(0.35);
        doc.roundedRect(M, baseY - BOX + 0.6, BOX, BOX, 0.8, 0.8, 'S');
        if (it.checked) {
          doc.setLineWidth(0.6);
          doc.line(M + 0.9, baseY - BOX / 2 + 0.6, M + BOX / 2 - 0.3, baseY - 0.3);
          doc.line(M + BOX / 2 - 0.3, baseY - 0.3, M + BOX - 0.7, baseY - BOX + 1.4);
        }
        doc.setFont('Geist', 'normal'); doc.setFontSize(ITEM_PT);
        doc.setTextColor.apply(doc, it.checked ? MUTED : INK);
        m.lines.forEach(function (l, i) { doc.text(l, M + BOX + GAP_X, baseY + i * lh(ITEM_PT)); });
        doc.setFont('Geist', 'bold');
        doc.text(m.qty, W - M, baseY, { align: 'right' });
        y = top + m.h;
      }
      var usable = BOTTOM - M;
      groups.forEach(function (g) {
        var ms = g.items.map(measureItem);
        var blockH = headH() + ms.reduce(function (s, m) { return s + m.h; }, 0) + 3;
        // Категория не рвётся между страницами, если помещается целиком
        if (y + blockH > BOTTOM && blockH <= usable) newPage();
        else if (y + headH() + (ms[0] ? ms[0].h : 0) > BOTTOM) newPage();
        drawHead(g.name);
        g.items.forEach(function (it, i) {
          if (y + ms[i].h > BOTTOM) { newPage(); drawHead(g.name + ' (продолжение)'); }
          drawItem(it, ms[i]);
        });
        y += 3;
      });

      var n = doc.getNumberOfPages();
      for (var p = 1; p <= n; p++) {
        doc.setPage(p);
        doc.setFont('Geist', 'normal'); doc.setFontSize(11); doc.setTextColor.apply(doc, MUTED);
        doc.text('Стр. ' + p + ' из ' + n, W / 2, H - 7, { align: 'center' });
      }
      return doc;
    }
    function fileName(d) { return 'shopping-list-' + U.todayISO(d) + '.pdf'; }
    function exportShopping(onlyUnchecked) {
      var items = DB.state.shopping.filter(function (it) { return !onlyUnchecked || !it.checked; });
      if (!items.length) return Promise.reject(new Error(onlyUnchecked ? 'Все позиции уже куплены — экспортировать нечего.' : 'Список покупок пуст.'));
      return Promise.all([ensureJsPDF(), ensureFonts()]).then(function (r) {
        var doc = build(r[0], r[1], items, {});
        var name = fileName();
        doc.save(name);
        return { name: name, pages: doc.getNumberOfPages(), doc: doc };
      });
    }
    return { exportShopping: exportShopping, ensureJsPDF: ensureJsPDF, ensureFonts: ensureFonts, fileName: fileName, build: build, loadScript: loadScript };
  })();
  Foodly.PDF = PDF;

  /* =======================================================================
   * Backup — экспорт/импорт JSON, валидация, сброс к демо
   * ======================================================================= */
  var Backup = (function () {
    /* Экспорт: все данные + фото из IndexedDB (как data: URL, только те, на которые ссылаются рецепты) */
    function exportJSON() {
      var data = DB.exportData();
      var ref = {};
      DB.state.recipes.forEach(function (r) { if (r.photoId) ref[r.photoId] = true; });
      var photosP = PhotoStore.isAvailable() ? PhotoStore.all() : Promise.resolve([]);
      return photosP.then(function (recs) {
        return Promise.all(recs.filter(function (r) { return ref[r.id]; }).map(function (r) {
          return PhotoStore.blobToDataURL(r.blob).then(function (url) {
            return { id: r.id, type: r.type, url: r.url || null, source: r.source || 'upload', createdAt: r.createdAt || null, data: url };
          });
        }));
      }).then(function (photos) {
        data.data.photos = photos;
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        var name = 'foodly-backup-' + U.todayISO() + '.json';
        U.download(name, blob);
        return { name: name, photos: photos.length, bytes: blob.size };
      });
    }
    function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
    function validate(obj) {
      if (!isObj(obj)) return { ok: false, error: 'Файл не похож на резервную копию Foodly! (ожидался JSON-объект).' };
      var d = obj.data;
      if (!isObj(d)) return { ok: false, error: 'В файле нет раздела data — это не резервная копия Foodly!.' };
      var v = Number(obj.schemaVersion);
      if (!v || v < 1) return { ok: false, error: 'В файле не указана версия схемы (schemaVersion).' };
      if (v > Storage.SCHEMA_VERSION) return { ok: false, error: 'Файл создан более новой версией приложения (схема ' + v + '). Обновите приложение.' };
      var errs = [];
      if (d.products != null && !Array.isArray(d.products)) errs.push('products должен быть массивом');
      if (d.recipes != null && !Array.isArray(d.recipes)) errs.push('recipes должен быть массивом');
      if (d.shopping != null && !Array.isArray(d.shopping)) errs.push('shopping должен быть массивом');
      if (d.fridge != null && !Array.isArray(d.fridge)) errs.push('fridge должен быть массивом');
      (d.fridge || []).forEach(function (x, i) {
        if (!isObj(x) || typeof x.productId !== 'string') errs.push('продукт холодильника №' + (i + 1) + ' повреждён');
      });
      (d.products || []).forEach(function (p, i) {
        if (!isObj(p) || typeof p.id !== 'string' || typeof p.name !== 'string' || !isObj(p.per100)) errs.push('продукт №' + (i + 1) + ' повреждён');
      });
      (d.recipes || []).forEach(function (r, i) {
        if (!isObj(r) || typeof r.id !== 'string' || typeof r.title !== 'string' || !Array.isArray(r.ingredients)) errs.push('рецепт №' + (i + 1) + ' повреждён');
      });
      (d.shopping || []).forEach(function (s, i) {
        if (!isObj(s) || typeof s.id !== 'string' || typeof s.name !== 'string') errs.push('позиция списка №' + (i + 1) + ' повреждена');
      });
      if (d.settings != null && !isObj(d.settings)) errs.push('settings должен быть объектом');
      if (d.plan != null && (!isObj(d.plan) || !Array.isArray(d.plan.days))) errs.push('план питания повреждён');
      if (d.photos != null && !Array.isArray(d.photos)) errs.push('photos должен быть массивом');
      (d.photos || []).forEach(function (ph, i) {
        if (!isObj(ph) || typeof ph.id !== 'string' || typeof ph.data !== 'string' || ph.data.indexOf('data:image/') !== 0) errs.push('фото №' + (i + 1) + ' повреждено');
      });
      if (errs.length) return { ok: false, error: 'Файл повреждён: ' + errs.slice(0, 3).join('; ') + (errs.length > 3 ? ' и ещё ' + (errs.length - 3) : '') + '.' };
      var data = Storage.migrate(U.clone(d), v);
      return { ok: true, data: data, counts: { recipes: (data.recipes || []).length, products: (data.products || []).length, shopping: (data.shopping || []).length, fridge: (data.fridge || []).length,
        photos: (data.photos || []).length + (data.recipes || []).filter(function (r) { return typeof r.photo === 'string' && r.photo.indexOf('data:') === 0; }).length } };
    }
    function mergeById(cur, inc, preferIncoming) {
      var map = {};
      cur.forEach(function (x, i) { map[x.id] = i; });
      inc.forEach(function (x) {
        if (map[x.id] == null) { cur.push(x); return; }
        if (preferIncoming(cur[map[x.id]], x)) cur[map[x.id]] = x;
      });
      return cur;
    }
    /* Фото из копии → IndexedDB (или inline, если IndexedDB недоступна). Возвращает Promise */
    function importPhotos(photos, recipes, mode) {
      if (!photos.length) return mode === 'replace' ? PhotoStore.clear() : Promise.resolve();
      if (!PhotoStore.isAvailable()) {
        var byId = {};
        photos.forEach(function (ph) { byId[ph.id] = ph.data; });
        recipes.forEach(function (r) { if (r.photoId && byId[r.photoId]) { r.photo = byId[r.photoId]; r.photoId = null; } });
        return Promise.resolve();
      }
      var start = mode === 'replace' ? PhotoStore.clear() : Promise.resolve();
      return start.then(function () {
        return Promise.all(photos.map(function (ph) {
          if (mode !== 'replace' && PhotoStore.has(ph.id)) return null;
          var blob;
          try { blob = PhotoStore.dataURLToBlob(ph.data); } catch (e) { return null; }
          return PhotoStore.putRecord({ id: ph.id, blob: blob, type: blob.type, url: ph.url || null, source: ph.source || 'upload', createdAt: ph.createdAt || Date.now(), size: blob.size });
        }));
      });
    }
    function importData(data, mode) {
      var s = DB.state;
      var photos = data.photos || [];
      delete data.photos;
      return importPhotos(photos, data.recipes || [], mode).then(function () {
        if (mode === 'replace') {
          s.products = data.products || Models.buildProducts();
          s.recipes = data.recipes || [];
          s.shopping = data.shopping || [];
          s.fridge = data.fridge || [];
          s.plan = data.plan || null;
          s.settings = data.settings || Models.defaultSettings();
        } else {
          mergeById(s.products, data.products || [], function (a, b) { return b.isCustom || !a.isCustom; });
          mergeById(s.recipes, data.recipes || [], function (a, b) { return (b.updatedAt || 0) > (a.updatedAt || 0); });
          mergeById(s.shopping, data.shopping || [], function () { return false; });
          // холодильник: добавляем продукты, которых ещё нет (по productId)
          var inFridge = {}; (s.fridge || []).forEach(function (x) { inFridge[x.productId] = true; });
          s.fridge = s.fridge || [];
          (data.fridge || []).forEach(function (x) { if (x && x.productId && !inFridge[x.productId]) { s.fridge.push(x); inFridge[x.productId] = true; } });
          if (!s.plan && data.plan) s.plan = data.plan;
          if (data.settings) {
            var ids = {};
            s.settings.categories.forEach(function (c) { ids[c.id] = true; });
            (data.settings.categories || []).forEach(function (c) { if (!ids[c.id]) s.settings.categories.push(c); });
            var ex = s.settings.restrictions.excluded;
            ((data.settings.restrictions || {}).excluded || []).forEach(function (id) { if (ex.indexOf(id) < 0) ex.push(id); });
            // «всегда есть дома»: объединяем списки
            if (data.settings.pantry && s.settings.pantry) ['categories', 'products'].forEach(function (k) {
              (data.settings.pantry[k] || []).forEach(function (id) { if (s.settings.pantry[k].indexOf(id) < 0) s.settings.pantry[k].push(id); });
            });
            // диеты: добавляем недостающие по id
            if (Array.isArray(data.settings.diets)) {
              s.settings.diets = s.settings.diets || [];
              var dIds = {}; s.settings.diets.forEach(function (x) { dIds[x.id] = true; });
              data.settings.diets.forEach(function (x) { if (x && x.id && !dIds[x.id]) s.settings.diets.push(x); });
            }
          }
        }
        DB.ensureIntegrity();
        var ok = DB.saveAll();
        // старые копии (фото inline) → IndexedDB; затем убираем лишнее
        return PhotoStore.migrateInline().then(function () { PhotoStore.fixDangling(); return PhotoStore.gc(); }).then(function () { return ok; });
      });
    }
    function resetDemo() {
      return PhotoStore.clear().then(function () { DB.seed(); DB.ensureIntegrity(); return DB.saveAll(); });
    }
    return { exportJSON: exportJSON, validate: validate, importData: importData, resetDemo: resetDemo };
  })();
  Foodly.Backup = Backup;

  /* =======================================================================
   * UI/Router — базовые компоненты: DOM-хелперы, тосты, модалки, автоподстановка
   * ======================================================================= */
  var UI = (function () {
    function h(html) {
      var t = document.createElement('template');
      t.innerHTML = String(html).trim();
      return t.content.firstElementChild;
    }
    function $(sel, root) { return (root || document).querySelector(sel); }
    function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
    var idc = 0;
    function nextId(p) { idc += 1; return (p || 'f') + '-' + idc; }

    /* ---------- Toast ---------- */
    var toastBox = null;
    function toast(msg, opts) {
      opts = opts || {};
      if (!toastBox) toastBox = $('#toasts');
      var el = h('<div class="toast' + (opts.type ? ' toast-' + opts.type : '') + '" role="' + (opts.type === 'error' ? 'alert' : 'status') + '">' +
        '<span class="toast-msg"></span>' +
        (opts.actionLabel ? '<button type="button" class="toast-action"></button>' : '') +
        '<button type="button" class="toast-close" aria-label="Закрыть уведомление">✕</button></div>');
      $('.toast-msg', el).textContent = msg;
      var timer;
      function close() { clearTimeout(timer); el.classList.add('toast-out'); setTimeout(function () { el.remove(); }, 200); }
      if (opts.actionLabel) {
        var b = $('.toast-action', el);
        b.textContent = opts.actionLabel;
        b.addEventListener('click', function () { close(); if (opts.onAction) opts.onAction(); });
      }
      $('.toast-close', el).addEventListener('click', close);
      toastBox.appendChild(el);
      var ms = opts.timeout != null ? opts.timeout : (opts.actionLabel ? 5000 : (opts.type === 'error' ? 7000 : 3500));
      if (ms > 0) timer = setTimeout(close, ms);
      while (toastBox.children.length > (global.innerWidth < 760 ? 2 : 3)) toastBox.firstElementChild.remove();
      return { close: close };
    }

    /* ---------- Modal: role=dialog, aria-modal, ловушка фокуса, Esc, возврат фокуса ---------- */
    var stack = [];
    var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    function focusables(root) {
      return $$(FOCUSABLE, root).filter(function (el) { return el.offsetParent !== null || el === document.activeElement; });
    }
    function setInert() {
      var shell = $('#app-shell');
      if (shell) { if (stack.length) shell.setAttribute('inert', ''); else shell.removeAttribute('inert'); }
      stack.forEach(function (m, i) { if (i < stack.length - 1) m.overlay.setAttribute('inert', ''); else m.overlay.removeAttribute('inert'); });
      document.body.classList.toggle('modal-open', stack.length > 0);
    }
    /* Esc и Tab обрабатываем на уровне документа: работает, даже если фокус «выпал» из окна */
    document.addEventListener('keydown', function (e) {
      var top = stack[stack.length - 1];
      if (!top || !top.onKey) return;
      if (e.key === 'Tab' && !top.overlay.contains(document.activeElement)) {
        e.preventDefault();
        var f = focusables(top.overlay); if (f.length) (e.shiftKey ? f[f.length - 1] : f[0]).focus();
        return;
      }
      top.onKey(e);
    });
    function modal(opts) {
      var titleId = nextId('modal-title');
      var overlay = h('<div class="modal-overlay"><div class="modal modal-' + (opts.size || 'md') + '" role="dialog" aria-modal="true" aria-labelledby="' + titleId + '">' +
        '<header class="modal-head"><h2 class="modal-title" id="' + titleId + '"></h2>' +
        '<button type="button" class="icon-btn" data-close aria-label="Закрыть">✕</button></header>' +
        '<div class="modal-body"></div><footer class="modal-foot" hidden></footer></div></div>');
      $('.modal-title', overlay).textContent = opts.title || '';
      var body = $('.modal-body', overlay), foot = $('.modal-foot', overlay), dialog = $('.modal', overlay);
      if (opts.content) { if (typeof opts.content === 'string') body.innerHTML = opts.content; else body.appendChild(opts.content); }
      if (opts.footer) { foot.hidden = false; foot.appendChild(opts.footer); }
      var entry = { overlay: overlay, returnFocus: document.activeElement, closed: false };
      function close(result) {
        if (entry.closed) return;
        if (opts.beforeClose && opts.beforeClose(result) === false) return;
        entry.closed = true;
        overlay.classList.add('modal-closing');
        var idx = stack.indexOf(entry);
        if (idx >= 0) stack.splice(idx, 1);
        setTimeout(function () { overlay.remove(); }, 160);
        setInert();
        if (entry.returnFocus && document.contains(entry.returnFocus)) { try { entry.returnFocus.focus(); } catch (e) { /* noop */ } }
        if (opts.onClose) opts.onClose(result);
      }
      entry.close = close;
      overlay.addEventListener('mousedown', function (e) { entry.downOnOverlay = e.target === overlay; });
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay && entry.downOnOverlay && !opts.static) close();
        if (e.target.closest('[data-close]')) close();
      });
      entry.onKey = function (e) {
        if (stack[stack.length - 1] !== entry) return;
        if (e.key === 'Escape') {
          if (e.target.getAttribute('aria-expanded') === 'true') return; // закрытие выпадающего списка
          e.preventDefault(); close(); return;
        }
        if (e.key === 'Tab') {
          var f = focusables(dialog);
          if (!f.length) { e.preventDefault(); return; }
          var first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
      document.body.appendChild(overlay);
      stack.push(entry);
      setInert();
      var af = $('[autofocus]', body) || focusables(body)[0] || focusables(dialog)[0];
      setTimeout(function () { if (af) af.focus(); else dialog.focus(); }, 30);
      return { el: overlay, body: body, foot: foot, dialog: dialog, close: close };
    }
    function confirmDialog(o) {
      return new Promise(function (resolve) {
        var foot = h('<div class="btn-row"><button type="button" class="btn btn-ghost" data-v="0"></button><button type="button" class="btn ' + (o.danger ? 'btn-danger' : 'btn-primary') + '" data-v="1"></button></div>');
        foot.children[0].textContent = o.cancelText || 'Отмена';
        foot.children[1].textContent = o.okText || 'Подтвердить';
        var content = h('<div><p class="confirm-text"></p></div>');
        $('p', content).textContent = o.text || '';
        var result = false;
        var m = modal({ title: o.title, content: content, footer: foot, size: 'sm', onClose: function () { resolve(result); } });
        foot.addEventListener('click', function (e) {
          var b = e.target.closest('[data-v]'); if (!b) return;
          result = b.dataset.v === '1'; m.close();
        });
        setTimeout(function () { foot.children[o.danger ? 0 : 1].focus(); }, 40);
      });
    }
    /* Выбор из нескольких вариантов: options [{value,label,desc,primary}] */
    function choose(o) {
      return new Promise(function (resolve) {
        var content = h('<div class="choose"></div>');
        if (o.text) { var p = document.createElement('p'); p.className = 'muted'; p.textContent = o.text; content.appendChild(p); }
        var result = null;
        o.options.forEach(function (op) {
          var b = h('<button type="button" class="choose-opt' + (op.primary ? ' is-primary' : '') + '"><strong></strong><span class="muted"></span></button>');
          $('strong', b).textContent = op.label; $('span', b).textContent = op.desc || '';
          b.addEventListener('click', function () { result = op.value; m.close(); });
          content.appendChild(b);
        });
        var m = modal({ title: o.title, content: content, size: 'sm', onClose: function () { resolve(result); } });
      });
    }

    /* ---------- Autocomplete (combobox + listbox) ---------- */
    function autocomplete(input, o) {
      var listId = nextId('ac-list');
      var list = h('<ul class="ac-list" role="listbox" hidden></ul>');
      list.id = listId;
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-expanded', 'false');
      input.setAttribute('aria-controls', listId);
      input.setAttribute('autocomplete', 'off');
      input.parentNode.classList.add('ac-wrap');
      input.parentNode.appendChild(list);
      var items = [], active = -1;
      function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; }
      function setActive(i) {
        active = i;
        $$('.ac-opt', list).forEach(function (li, k) { li.setAttribute('aria-selected', k === i ? 'true' : 'false'); });
        if (i >= 0) { input.setAttribute('aria-activedescendant', listId + '-' + i); var li = document.getElementById(listId + '-' + i); if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' }); }
        else input.removeAttribute('aria-activedescendant');
      }
      function render() {
        var q = input.value.trim();
        items = q ? o.source(q) : [];
        var createLabel = q && o.onCreate && !items.some(function (it) { return U.norm(it.label) === U.norm(q); }) ? (o.createLabel ? o.createLabel(q) : '+ Создать «' + q + '»') : null;
        if (createLabel) items = items.concat([{ create: true, label: createLabel, q: q }]);
        list.innerHTML = '';
        items.forEach(function (it, i) {
          var li = h('<li class="ac-opt' + (it.create ? ' ac-create' : '') + '" role="option" aria-selected="false"><span class="ac-label"></span><span class="ac-sub"></span></li>');
          li.id = listId + '-' + i;
          $('.ac-label', li).textContent = it.label;
          $('.ac-sub', li).textContent = it.sub || '';
          li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(i); });
          list.appendChild(li);
        });
        if (items.length) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); setActive(items.length && !items[0].create ? 0 : -1); }
        else close();
      }
      function pick(i) {
        var it = items[i]; if (!it) return;
        close();
        if (it.create) o.onCreate(it.q); else o.onPick(it);
      }
      input.addEventListener('input', render);
      input.addEventListener('focus', function () { if (input.value.trim() && o.openOnFocus) render(); });
      input.addEventListener('keydown', function (e) {
        if (list.hidden) { if (e.key === 'ArrowDown' && input.value.trim()) { render(); e.preventDefault(); } return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(items.length - 1, active + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, active - 1)); }
        else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); e.stopPropagation(); pick(active); } else close(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === 'Tab') { close(); }
      });
      input.addEventListener('blur', function () { setTimeout(close, 120); });
      return { close: close, refresh: render };
    }
    function productSource(q) {
      return DB.searchProducts(q, 8).map(function (p) {
        return { id: p.id, label: p.name, sub: Math.round(p.per100.kcal) + ' ккал · ' + DB.categoryName(p.category), product: p };
      });
    }

    /* ---------- Мелкие элементы ---------- */
    function macroBar(ps) {
      var pk = ps.protein * 4, fk = ps.fat * 9, ck = ps.carbs * 4, sum = pk + fk + ck || 1;
      var p = Math.round(pk / sum * 100), f = Math.round(fk / sum * 100), c = Math.max(0, 100 - p - f);
      return '<div class="macro-bar" role="img" aria-label="Доля калорий: белки ' + p + '%, жиры ' + f + '%, углеводы ' + c + '%">' +
        '<span class="mb-p" style="width:' + p + '%"></span><span class="mb-f" style="width:' + f + '%"></span><span class="mb-c" style="width:' + c + '%"></span></div>';
    }
    function badgesHtml(ps) {
      return Nutrition.badges(ps).map(function (b) { return '<span class="badge badge-' + b.id + '">' + U.esc(b.label) + '</span>'; }).join('');
    }
    function mediaHtml(r, cls) {
      var ph = Recipes.placeholder(r);
      var phHtml = '<div class="ph ph-' + ph.meal + '" aria-hidden="true"><span>' + ph.emoji + '</span></div>';
      var src = (r.photoId && PhotoStore.url(r.photoId)) || r.photo || r.photoUrl;
      if (src) return '<div class="' + (cls || 'media') + '"><img src="' + U.esc(src) + '" alt="" loading="lazy" data-fallback="1">' + '<template>' + phHtml + '</template></div>';
      return '<div class="' + (cls || 'media') + '">' + phHtml + '</div>';
    }
    function emptyState(o) {
      var el = h('<div class="empty"><div class="empty-emoji" aria-hidden="true"></div><h2 class="empty-title"></h2><p class="muted"></p></div>');
      $('.empty-emoji', el).textContent = o.emoji || '🍽️';
      $('.empty-title', el).textContent = o.title;
      $('p', el).textContent = o.text || '';
      if (o.actionLabel) {
        var b = h('<button type="button" class="btn btn-primary"></button>');
        b.textContent = o.actionLabel; b.addEventListener('click', o.onAction);
        el.appendChild(b);
      }
      return el;
    }
    function switchHtml(id, label, checked, extra) {
      return '<button type="button" class="switch" role="switch" id="' + id + '" aria-checked="' + (checked ? 'true' : 'false') + '"' + (extra || '') + '>' +
        '<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span><span class="switch-label">' + U.esc(label) + '</span></button>';
    }
    function fieldError(input, msg) {
      var wrap = input.closest('.field') || input.parentNode;
      var err = $('.field-error', wrap);
      if (!err) { err = h('<p class="field-error" role="alert"></p>'); err.id = nextId('err'); wrap.appendChild(err); }
      if (msg) {
        err.textContent = msg; err.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', err.id);
      } else {
        err.textContent = ''; err.hidden = true;
        input.removeAttribute('aria-invalid');
      }
      return !msg;
    }
    return { h: h, $: $, $$: $$, nextId: nextId, toast: toast, modal: modal, confirm: confirmDialog, choose: choose,
      autocomplete: autocomplete, productSource: productSource, macroBar: macroBar, badgesHtml: badgesHtml, mediaHtml: mediaHtml,
      emptyState: emptyState, switchHtml: switchHtml, fieldError: fieldError, stackSize: function () { return stack.length; } };
  })();
  Foodly.UI = UI;
  var h = UI.h, $ = UI.$, $$ = UI.$$;

  /* =======================================================================
   * Theme — светлая/тёмная тема, без вспышки (атрибут ставится в <head>)
   * ======================================================================= */
  var Theme = (function () {
    var mq = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;
    function current() { return document.documentElement.getAttribute('data-theme') || 'light'; }
    function apply(t, animate) {
      var root = document.documentElement;
      if (animate) {
        root.classList.add('theme-anim');
        setTimeout(function () { root.classList.remove('theme-anim'); }, 450);
      }
      root.setAttribute('data-theme', t);
      var meta = $('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', t === 'dark' ? '#1a1a1d' : '#f8f6fd');
      $$('[data-theme-toggle]').forEach(function (b) {
        b.setAttribute('aria-checked', t === 'dark' ? 'true' : 'false');
        b.setAttribute('aria-label', t === 'dark' ? 'Тёмная тема включена' : 'Тёмная тема выключена');
      });
    }
    function set(t) {
      Storage.set('theme', t);
      DB.state.settings.theme = t;
      DB.save('settings');
      apply(t, true);
    }
    function toggle() { set(current() === 'dark' ? 'light' : 'dark'); }
    function init() {
      var saved = Storage.get('theme', null);
      apply(saved === 'dark' || saved === 'light' ? saved : (mq && mq.matches ? 'dark' : 'light'), false);
      if (mq && mq.addEventListener) mq.addEventListener('change', function (e) {
        if (!Storage.get('theme', null)) apply(e.matches ? 'dark' : 'light', true);
      });
    }
    return { init: init, toggle: toggle, set: set, current: current, apply: apply };
  })();
  Foodly.Theme = Theme;

  /* =======================================================================
   * UI: Рецепты — список, просмотр, форма
   * ======================================================================= */
  var RecipesView = (function () {
    var f = { text: '', meal: '', tag: '', badge: '', kcalMin: '', kcalMax: '', diets: [], sort: 'new' };
    var root = null;

    var VIEWS = [
      { id: 'large', label: 'Крупные карточки', icon: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="2" y="2" width="7" height="7" rx="1.5"/><rect x="11" y="2" width="7" height="7" rx="1.5"/><rect x="2" y="11" width="7" height="7" rx="1.5"/><rect x="11" y="11" width="7" height="7" rx="1.5"/></svg>' },
      { id: 'small', label: 'Мелкие карточки', icon: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="2" y="2" width="4" height="4" rx="1"/><rect x="8" y="2" width="4" height="4" rx="1"/><rect x="14" y="2" width="4" height="4" rx="1"/><rect x="2" y="8" width="4" height="4" rx="1"/><rect x="8" y="8" width="4" height="4" rx="1"/><rect x="14" y="8" width="4" height="4" rx="1"/><rect x="2" y="14" width="4" height="4" rx="1"/><rect x="8" y="14" width="4" height="4" rx="1"/><rect x="14" y="14" width="4" height="4" rx="1"/></svg>' },
      { id: 'list', label: 'Список', icon: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="2" y="3" width="4" height="4" rx="1"/><rect x="8" y="4" width="10" height="2" rx="1"/><rect x="2" y="13" width="4" height="4" rx="1"/><rect x="8" y="14" width="10" height="2" rx="1"/></svg>' }
    ];
    function viewMode() { var v = DB.state.settings.recipeView; return VIEWS.some(function (x) { return x.id === v; }) ? v : 'large'; }

    function render() {
      var tags = Recipes.allTags();
      root = h('<section class="view" aria-labelledby="h-recipes">' +
        '<div class="view-head"><div><h1 id="h-recipes" tabindex="-1">Рецепты</h1></div>' +
        '<div class="btn-row wrap"><button type="button" class="btn btn-secondary" data-act="wheel"><span aria-hidden="true">🎡</span> Что приготовить?</button>' +
        '<button type="button" class="btn btn-primary" data-act="new"><span aria-hidden="true">＋</span> Новый рецепт</button></div></div>' +
        '<div class="recipes-layout">' +
        '<aside class="filters card" aria-label="Поиск, фильтры и сортировка">' +
        '<div class="field field-search"><label class="sr-only" for="rf-text">Поиск рецептов</label>' +
        '<input id="rf-text" type="search" placeholder="Название или ингредиент" value="' + U.esc(f.text) + '"></div>' +
        '<fieldset class="field"><legend>Приём пищи</legend><div class="chips meal-chips">' +
        '<button type="button" class="chip" data-meal="" aria-pressed="' + (!f.meal) + '">Все</button>' +
        Models.MEALS.map(function (m) { return '<button type="button" class="chip m-' + m.id + '" data-meal="' + m.id + '" aria-pressed="' + (f.meal === m.id) + '">' + m.emoji + ' ' + m.name + '</button>'; }).join('') +
        '</div></fieldset>' +
        '<button type="button" class="btn btn-ghost btn-sm filters-toggle" aria-expanded="false" aria-controls="rf-more">Фильтры и сортировка</button>' +
        '<div class="filter-row" id="rf-more">' +
        '<fieldset class="field field-diets"><legend>Диета</legend><div class="chips diet-chips">' +
        Diets.all().map(function (d) { return '<button type="button" class="chip" data-diet="' + U.esc(d.id) + '" aria-pressed="' + (f.diets.indexOf(d.id) >= 0) + '">' + U.esc(Diets.label(d)) + '</button>'; }).join('') +
        '</div></fieldset>' +
        '<div class="field"><label for="rf-sort">Сортировка</label><select id="rf-sort">' +
        [['new', 'Сначала новые'], ['title', 'По названию'], ['kcal', 'Сначала менее калорийные'], ['kcal-desc', 'Сначала более калорийные']].map(function (o) {
          return '<option value="' + o[0] + '"' + (f.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') + '</select></div>' +
        '<div class="field"><label for="rf-tag">Тег или кухня</label><select id="rf-tag"><option value="">Любые</option>' +
        tags.map(function (t) { return '<option' + (f.tag === t ? ' selected' : '') + '>' + U.esc(t) + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label for="rf-badge">Польза</label><select id="rf-badge"><option value="">Любые блюда</option>' +
        '<option value="protein"' + (f.badge === 'protein' ? ' selected' : '') + '>Высокобелковые</option>' +
        '<option value="fiber"' + (f.badge === 'fiber' ? ' selected' : '') + '>С большим количеством клетчатки</option></select></div>' +
        '<fieldset class="field field-range"><legend>Калорий на порцию</legend><div class="range-inputs">' +
        '<input id="rf-min" type="text" inputmode="numeric" placeholder="от" aria-label="Калорий на порцию от" value="' + U.esc(f.kcalMin) + '">' +
        '<span aria-hidden="true">—</span><input id="rf-max" type="text" inputmode="numeric" placeholder="до" aria-label="Калорий на порцию до" value="' + U.esc(f.kcalMax) + '"></div></fieldset>' +
        '<button type="button" class="link-btn small" data-act="reset">Сбросить фильтры</button>' +
        '</div></aside>' +
        '<div class="recipes-main"><div class="list-toolbar"><p class="muted" id="recipes-count" aria-live="polite"></p>' +
        '<div class="view-switch" role="group" aria-label="Вид списка">' +
        VIEWS.map(function (v) { return '<button type="button" class="icon-btn" data-view="' + v.id + '" aria-pressed="' + (viewMode() === v.id) + '" aria-label="' + v.label + '" title="' + v.label + '">' + v.icon + '</button>'; }).join('') +
        '</div></div>' +
        '<div class="drafts-box" id="drafts-box" hidden></div>' +
        '<div class="recipe-grid view-' + viewMode() + '" id="recipe-grid"></div></div></div></section>');

      $('[data-act="new"]', root).addEventListener('click', function () { openForm(null); });
      $('[data-act="wheel"]', root).addEventListener('click', function () { WheelView.open(); });
      $('[data-act="wheel"]', root).hidden = !Recipes.ready().length;
      $('[data-act="reset"]', root).addEventListener('click', function () {
        f = { text: '', meal: '', tag: '', badge: '', kcalMin: '', kcalMax: '', diets: [], sort: 'new' };
        Router.refresh();
        var t = $('#rf-text'); if (t) t.focus();
      });
      $$('[data-view]', root).forEach(function (b) {
        b.addEventListener('click', function () {
          DB.state.settings.recipeView = b.dataset.view; DB.save('settings');
          $$('[data-view]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
          $('#recipe-grid', root).className = 'recipe-grid view-' + b.dataset.view;
        });
      });
      var ft = $('.filters-toggle', root);
      function activeFilters() { return [f.tag, f.badge, f.kcalMin, f.kcalMax].filter(Boolean).length + f.diets.length + (f.sort !== 'new' ? 1 : 0); }
      function syncToggle() {
        var n = activeFilters();
        ft.textContent = 'Фильтры и сортировка' + (n ? ' (' + n + ')' : '');
        $('[data-act="reset"]', root).hidden = !n && !f.text;
      }
      ft.addEventListener('click', function () {
        var open = ft.getAttribute('aria-expanded') !== 'true';
        ft.setAttribute('aria-expanded', String(open));
        $('.filters', root).classList.toggle('is-open', open);
      });
      if (activeFilters()) { ft.setAttribute('aria-expanded', 'true'); $('.filters', root).classList.add('is-open'); }
      syncToggle();
      root.addEventListener('change', syncToggle);
      root.addEventListener('input', syncToggle);
      root.addEventListener('click', function (e) { if (e.target.closest('.meal-chips') || e.target.closest('.diet-chips')) syncToggle(); });
      $('#rf-text', root).addEventListener('input', U.debounce(function (e) { f.text = e.target.value; updateGrid(); syncToggle(); }, 150));
      $$('.meal-chips .chip', root).forEach(function (c) {
        c.addEventListener('click', function () {
          f.meal = c.dataset.meal;
          $$('.meal-chips .chip', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === c)); });
          updateGrid(); syncToggle();
        });
      });
      $$('.diet-chips .chip', root).forEach(function (c) {
        c.addEventListener('click', function () {
          var id = c.dataset.diet, i = f.diets.indexOf(id);
          if (i >= 0) f.diets.splice(i, 1); else f.diets.push(id);
          c.setAttribute('aria-pressed', String(i < 0));
          updateGrid(); syncToggle();
        });
      });
      $('#drafts-box', root).addEventListener('click', function (e) {
        var del = e.target.closest('[data-del-draft]');
        if (del) { deleteDraft(del.dataset.delDraft); return; }
        var b = e.target.closest('[data-draft]'); if (b) openForm(b.dataset.draft);
      });
      $('#rf-tag', root).addEventListener('change', function (e) { f.tag = e.target.value; updateGrid(); });
      $('#rf-badge', root).addEventListener('change', function (e) { f.badge = e.target.value; updateGrid(); });
      $('#rf-sort', root).addEventListener('change', function (e) { f.sort = e.target.value; updateGrid(); });
      ['#rf-min', '#rf-max'].forEach(function (s) {
        $(s, root).addEventListener('input', U.debounce(function () { f.kcalMin = $('#rf-min', root).value; f.kcalMax = $('#rf-max', root).value; updateGrid(); }, 250));
      });
      $('#recipe-grid', root).addEventListener('click', function (e) {
        var b = e.target.closest('[data-open]'); if (b) openRecipe(b.dataset.open);
      });
      updateGrid();
      return root;
    }
    function updateGrid() {
      if (!root) return;
      var grid = $('#recipe-grid', root);
      var total = Recipes.ready().length;
      renderDrafts();
      var list = Recipes.query({ text: f.text, meal: f.meal, tag: f.tag, badge: f.badge, diets: f.diets,
        kcalMin: f.kcalMin === '' ? null : U.parseNum(f.kcalMin), kcalMax: f.kcalMax === '' ? null : U.parseNum(f.kcalMax), sort: f.sort });
      $('#recipes-count', root).textContent = total ? (list.length === total ? total + ' ' + U.plural(total, 'рецепт', 'рецепта', 'рецептов') : 'Найдено ' + list.length + ' из ' + total) : '';
      grid.innerHTML = '';
      $('.filters', root).hidden = !total;
      $('.list-toolbar', root).hidden = !total;
      root.classList.toggle('no-recipes', !total);
      if (!total) {
        grid.appendChild(UI.emptyState({ emoji: '📖', title: 'Рецептов пока нет', text: 'Добавьте первый рецепт — калории, белки, жиры и углеводы на порцию посчитаются сами.', actionLabel: 'Создать рецепт', onAction: function () { openForm(null); } }));
        return;
      }
      if (!list.length) {
        grid.appendChild(UI.emptyState({ emoji: '🔍', title: 'Ничего не найдено', text: 'Измените запрос или сбросьте фильтры.', actionLabel: 'Сбросить фильтры', onAction: function () {
          f = { text: '', meal: '', tag: '', badge: '', kcalMin: '', kcalMax: '', diets: [], sort: f.sort };
          Router.refresh();
        } }));
        return;
      }
      grid.innerHTML = list.map(cardHtml).join('');
    }
    /* ---------- Черновики: отдельный блок над сеткой ---------- */
    function draftTitle(r) { return (r.title || '').trim() || 'Без названия'; }
    function renderDrafts() {
      var box = $('#drafts-box', root); if (!box) return;
      var list = Recipes.drafts();
      box.hidden = !list.length;
      if (!list.length) { box.innerHTML = ''; return; }
      box.innerHTML = '<h2 class="drafts-title">Черновики <span class="muted">(' + list.length + ')</span></h2>' +
        '<p class="muted small drafts-hint">Черновики не попадают в поиск, меню и колесо. Откройте черновик, чтобы дописать и сохранить рецепт.</p>' +
        '<ul class="drafts-list">' + list.map(function (r) {
          var nIng = (r.ingredients || []).filter(function (i) { return i.productId || (i.name || '').trim(); }).length;
          var when = r.updatedAt ? new Date(r.updatedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
          var orig = r.draftOf ? DB.recipe(r.draftOf) : null;
          return '<li class="draft-item"><button type="button" class="draft-btn" data-draft="' + U.esc(r.id) + '">' +
            '<span class="draft-emoji" aria-hidden="true">📝</span><span class="draft-text"><span class="draft-name">' + U.esc(draftTitle(r)) + '</span>' +
            '<span class="muted small">' + (orig ? 'Несохранённые изменения рецепта · ' : '') + nIng + ' ' + U.plural(nIng, 'ингредиент', 'ингредиента', 'ингредиентов') + (when ? ' · изменён ' + U.esc(when) : '') + '</span></span></button>' +
            '<button type="button" class="icon-btn" data-del-draft="' + U.esc(r.id) + '" aria-label="Удалить черновик «' + U.esc(draftTitle(r)) + '»">✕</button></li>';
        }).join('') + '</ul>';
    }
    function deleteDraft(id) {
      var r = DB.recipe(id); if (!r) return;
      var entry = Recipes.remove(id);
      Router.refresh();
      UI.toast('Черновик «' + draftTitle(r) + '» удалён', { actionLabel: 'Отменить', onAction: function () { Recipes.restore(entry); Router.refresh(); } });
    }
    function mealPills(r) {
      return (r.meals || []).map(function (m) { return '<span class="meal-pill m-' + m + '">' + U.esc(Models.mealName(m)) + '</span>'; }).join('');
    }
    function cardHtml(r) {
      var ps = Nutrition.perServing(r);
      var main = (r.meals || [])[0] || 'none';
      return '<article class="recipe-card m-' + main + '"><button type="button" class="recipe-card-btn" data-open="' + U.esc(r.id) + '" aria-label="' + U.esc(r.title + ', ' + Math.round(ps.kcal) + ' ккал на порцию') + '">' +
        UI.mediaHtml(r, 'recipe-media') + '<span class="kcal-badge">' + U.fmt(ps.kcal) + ' ккал</span>' +
        '<span class="recipe-body"><span class="recipe-title">' + U.esc(r.title) + '</span>' +
        '<span class="recipe-pills">' + mealPills(r) + '</span>' +
        '<span class="recipe-meta">Белки ' + U.fmt(ps.protein) + ' г, жиры ' + U.fmt(ps.fat) + ' г, углеводы ' + U.fmt(ps.carbs) + ' г</span>' +
        UI.macroBar(ps) + '<span class="badges">' + UI.badgesHtml(ps) + (ps.issues.length ? '<span class="badge badge-warn">Нет веса единицы</span>' : '') + '</span></span></button></article>';
    }

    /* ---------- Просмотр рецепта ---------- */
    function amountLabel(amount, unit) {
      if (unit === 'по вкусу') return 'по вкусу';
      if (unit === 'щепотка') return U.fmt(amount || 1, 1) + ' ' + U.plural(amount || 1, 'щепотка', 'щепотки', 'щепоток');
      return U.fmt(amount, amount < 10 ? 2 : amount < 100 ? 1 : 0) + ' ' + unit;
    }
    function dietFitHtml(r) {
      var pc = Nutrition.macroPct(Nutrition.perServing(r));
      var ratio = '<p class="macro-pct small muted">Доли калорий: жиры ' + U.fmt(pc.fat) + '%, белки ' + U.fmt(pc.protein) + '%, углеводы ' + U.fmt(pc.carbs) + '%</p>';
      return ratio + dietFitList(r);
    }
    function dietFitList(r) {
      var m = Diets.matching(r);
      if (!m.length) return Diets.all().length ? '<p class="diet-fit small muted">Не подходит ни под одну из диет</p>' : '';
      return '<p class="diet-fit small"><strong>Подходит:</strong> ' + m.map(function (d) { return '<span class="diet-tag">' + U.esc(Diets.label(d)) + '</span>'; }).join(' ') + '</p>';
    }
    function openRecipe(id) {
      var r = DB.recipe(id);
      if (!r) return;
      if (r.draft) { openForm(id); return; }
      var ps = Nutrition.perServing(r);
      var portions = r.servings;
      var content = h('<div class="recipe-view">' + UI.mediaHtml(r, 'rv-media') +
        '<div class="rv-meta"></div>' +
        '<div class="nutri-grid" aria-label="КБЖУ на порцию">' +
        [['Ккал', ps.kcal, ''], ['Белки', ps.protein, ' г'], ['Жиры', ps.fat, ' г'], ['Углеводы', ps.carbs, ' г'], ['Клетчатка', ps.fiber, ' г']].map(function (x) {
          return '<div class="nutri"><span class="nutri-val">' + U.fmt(x[1], x[0] === 'Ккал' ? 0 : 1) + x[2] + '</span><span class="nutri-lbl">' + x[0] + '</span></div>';
        }).join('') + '</div>' + UI.macroBar(ps) +
        '<p class="muted small">На 1 порцию. Рецепт рассчитан на ' + r.servings + ' ' + U.plural(r.servings, 'порцию', 'порции', 'порций') + '.</p>' +
        '<div class="badges">' + UI.badgesHtml(ps) + '</div>' + dietFitHtml(r) +
        '<div class="rv-fridge small" hidden></div>' +
        '<div class="rv-section"><div class="rv-ing-head"><h3>Ингредиенты</h3>' +
        '<div class="rv-portions"><span class="muted small" id="rv-portions-lbl">Готовим порций:</span><div class="stepper" role="group" aria-labelledby="rv-portions-lbl"><button type="button" class="icon-btn" data-step="-1" aria-label="Меньше порций">−</button>' +
        '<output class="stepper-val" aria-live="polite"></output><button type="button" class="icon-btn" data-step="1" aria-label="Больше порций">+</button></div></div></div>' +
        '<ul class="ing-list"></ul></div>' +
        '<div class="rv-section"><h3>Приготовление</h3><ol class="steps-list">' + (r.steps || []).map(function (s) { return '<li>' + U.esc(s) + '</li>'; }).join('') + '</ol></div></div>');
      if (r.photoCredit && r.photoCredit.page && (r.photoUrl || r.photoId)) {
        var cr = h('<p class="photo-credit small">Фото: <a target="_blank" rel="noopener noreferrer"></a> · автор и лицензия на странице файла</p>');
        var a = $('a', cr); a.href = r.photoCredit.page; a.textContent = r.photoCredit.source || 'источник';
        $('.rv-media', content).insertAdjacentElement('afterend', cr);
      }
      var meta = $('.rv-meta', content);
      (r.meals || []).forEach(function (m) { meta.appendChild(h('<span class="meal-pill m-' + m + '">' + U.esc(Models.mealName(m)) + '</span>')); });
      if (r.cuisine) meta.appendChild(h('<span class="tag">' + U.esc(r.cuisine) + '</span>'));
      (r.tags || []).forEach(function (t) { meta.appendChild(h('<span class="tag tag-free">#' + U.esc(t) + '</span>')); });
      function renderIng() {
        var k = portions / r.servings;
        $('.stepper-val', content).textContent = portions + ' ' + U.plural(portions, 'порция', 'порции', 'порций');
        $('.ing-list', content).innerHTML = r.ingredients.map(function (i) {
          var p = DB.product(i.productId);
          var g = Nutrition.toGrams(i.amount, i.unit, p);
          return '<li><span>' + U.esc(p ? p.name : '(продукт удалён)') + '</span><span class="ing-amt">' + amountLabel(Nutrition.NON_COUNTED[i.unit] ? i.amount : i.amount * k, i.unit) +
            (g.status === 'missing' ? ' <span class="warn-inline" title="Не задан вес единицы">⚠</span>' : '') + '</span></li>';
        }).join('');
        $('[data-step="-1"]', content).disabled = portions <= 1;
        renderFridge();
      }
      /* Холодильник: сколько ингредиентов уже есть дома (на выбранное число порций) */
      function renderFridge() {
        var box = $('.rv-fridge', content);
        if (!Fridge.all().length) { box.hidden = true; return; }
        var fm = Fridge.match(r, portions / r.servings);
        if (!fm.total) { box.hidden = true; return; }
        box.hidden = false;
        box.innerHTML = '<span class="rv-fridge-text"><span aria-hidden="true">🧊</span> Из холодильника есть <strong>' + fm.have.length + ' из ' + fm.total + '</strong>' +
          (fm.missing.length ? ' · не хватает: ' + U.esc(fm.missing.map(function (x) { return x.name; }).join(', ')) : ' — всё есть 🎉') + '</span>' +
          '<span class="rv-fridge-actions">' + (fm.missing.length ? '<button type="button" class="link-btn" data-fr="buy">Докупить недостающее</button>' : '') +
          (fm.have.length ? '<button type="button" class="link-btn" data-fr="cook">Приготовлено — списать из холодильника</button>' : '') + '</span>';
      }
      $('.rv-fridge', content).addEventListener('click', function (e) {
        var b = e.target.closest('[data-fr]'); if (!b) return;
        var mult = portions / r.servings;
        if (b.dataset.fr === 'buy') {
          var n = Fridge.buyMissing(r, null, mult);
          if (DB.save('shopping')) UI.toast('В список покупок: ' + n + ' ' + U.plural(n, 'продукт', 'продукта', 'продуктов') + ' для «' + r.title + '»', { actionLabel: 'Открыть список', onAction: function () { location.hash = '#shopping'; } });
        } else {
          var snap = Fridge.snapshot();
          var changed = Fridge.consume(r, mult);
          if (!changed) { UI.toast('Списывать нечего: у продуктов в холодильнике не указано количество'); return; }
          DB.save('fridge'); renderFridge(); if (Router.current() === 'fridge') FridgeView.refresh();
          UI.toast('Списано из холодильника: ' + changed + ' ' + U.plural(changed, 'продукт', 'продукта', 'продуктов') + ' (' + portions + ' ' + U.plural(portions, 'порция', 'порции', 'порций') + ')',
            { actionLabel: 'Отменить', onAction: function () { Fridge.restore(snap); renderFridge(); if (Router.current() === 'fridge') FridgeView.refresh(); } });
        }
      });
      $$('[data-step]', content).forEach(function (b) {
        b.addEventListener('click', function () { portions = Math.max(1, Math.min(99, portions + Number(b.dataset.step))); renderIng(); });
      });
      renderIng();
      var foot = h('<div class="btn-row btn-row-split"><button type="button" class="btn btn-ghost btn-danger-text" data-a="del">Удалить</button>' +
        '<div class="btn-row"><button type="button" class="btn btn-secondary" data-a="edit">Изменить</button>' +
        '<button type="button" class="btn btn-primary" data-a="shop">В список покупок</button></div></div>');
      var m = UI.modal({ title: r.title, content: content, footer: foot, size: 'lg' });
      foot.addEventListener('click', function (e) {
        var a = e.target.closest('[data-a]'); if (!a) return;
        if (a.dataset.a === 'shop') {
          var before = DB.state.shopping.length;
          Shopping.addRecipe(r, portions, 'recipe');
          if (DB.save('shopping')) {
            var added = DB.state.shopping.length - before;
            UI.toast('«' + r.title + '» ×' + portions + ' ' + U.plural(portions, 'порция', 'порции', 'порций') + ' → в списке покупок' + (added ? ' (+' + added + ' поз.)' : ''), { actionLabel: 'Открыть список', onAction: function () { location.hash = '#shopping'; } });
          }
          m.close();
        } else if (a.dataset.a === 'edit') {
          m.close(); setTimeout(function () { openForm(r.id); }, 170);
        } else if (a.dataset.a === 'del') {
          m.close();
          var entry = Recipes.remove(r.id);
          Router.refresh();
          UI.toast('Рецепт «' + r.title + '» удалён', { actionLabel: 'Отменить', onAction: function () { Recipes.restore(entry); Router.refresh(); UI.toast('Рецепт восстановлен'); } });
        }
      });
    }

    /* ---------- Форма рецепта ---------- */
    function unitOptions(sel) {
      return Models.UNITS.map(function (u) { return '<option' + (u === sel ? ' selected' : '') + '>' + u + '</option>'; }).join('');
    }
    function catOptions(sel) {
      return DB.state.settings.categories.map(function (c) { return '<option value="' + U.esc(c.id) + '"' + (c.id === sel ? ' selected' : '') + '>' + U.esc(c.name) + '</option>'; }).join('');
    }
    function unitWeightLabel(unit) {
      if (unit === 'мл' || unit === 'л') return 'Плотность, г/мл';
      return 'Вес 1 ' + unit + ', г';
    }
    function unitKey(unit) { return unit === 'л' ? 'мл' : unit; }

    function openForm(id) {
      var src = id ? DB.recipe(id) : null;
      var d = src ? U.clone(src) : { id: U.uid('r'), title: '', photo: null, photoId: null, photoUrl: null, servings: 2, meals: [], cuisine: '', tags: [], ingredients: [], steps: [''] };
      /* Режимы: новый рецепт / черновик (можно «Сохранить черновик») или правка готового рецепта.
         Черновик с draftOf — несохранённые изменения готового рецепта (создаётся автосохранением). */
      var isPublished = !!(src && !src.draft);
      var draftMode = !isPublished;
      var origOf = src && src.draftOf ? DB.recipe(src.draftOf) : null;
      var snapshot = src ? U.clone(src) : null;   // для «Не сохранять» после автосохранения
      var copyId = null;                          // id черновика-копии при правке готового рецепта
      var autoSaved = false;                      // в этой форме было автосохранение
      var dirty = false;                          // есть изменения после открытия / последнего явного сохранения
      var allowClose = false;
      d.ingredients.forEach(function (i) { if (!i.productId && i.name) i._name = i.name; delete i.name; if (i.amount === 0 && i.unit === 'по вкусу') i.amount = ''; });
      if (!d.ingredients.length) d.ingredients.push({ productId: null, amount: '', unit: 'г' });
      if (!d.steps.length) d.steps.push('');
      var cuisines = {};
      Recipes.ready().forEach(function (r) { if (r.cuisine) cuisines[r.cuisine] = true; });
      var cuisineList = UI.nextId('cuisines');

      var form = h('<form class="recipe-form" novalidate>' +
        (src && src.draft ? '<p class="draft-note small">📝 ' + (origOf ? 'Несохранённые изменения рецепта «' + U.esc(origOf.title) + '». «Сохранить» заменит ими рецепт.' : 'Это черновик: он не попадает в поиск, меню и колесо, пока вы его не сохраните.') + '</p>' : '') +
        '<div class="form-grid">' +
        '<div class="field field-wide"><label for="rf-title">Название <span class="req" aria-hidden="true">*</span></label><input id="rf-title" type="text" required maxlength="120" autofocus></div>' +
        '<div class="field"><label for="rf-servings">Порций <span class="req" aria-hidden="true">*</span></label><input id="rf-servings" type="number" min="1" max="99" step="1" inputmode="numeric" required></div>' +
        '<div class="field"><label for="rf-cuisine">Кухня</label><input id="rf-cuisine" type="text" list="' + cuisineList + '" maxlength="40" placeholder="Например, Русская">' +
        '<datalist id="' + cuisineList + '">' + Object.keys(cuisines).map(function (c) { return '<option value="' + U.esc(c) + '">'; }).join('') + '</datalist></div>' +
        '<fieldset class="field field-wide"><legend>Приём пищи</legend><div class="check-row">' +
        Models.MEALS.map(function (m) { return '<label class="check"><input type="checkbox" name="meal" value="' + m.id + '"><span>' + m.emoji + ' ' + m.name + '</span></label>'; }).join('') + '</div></fieldset>' +
        '<div class="field field-wide"><label for="rf-tags">Свои теги</label><input id="rf-tags" type="text" placeholder="через запятую: быстро, постное"></div>' +
        '</div>' +
        '<fieldset class="form-section"><legend>Фото</legend><div class="photo-row"><div class="photo-preview"></div><div class="photo-ctrls">' +
        '<label class="btn btn-secondary btn-file">Загрузить файл<input type="file" accept="image/*" class="sr-only" id="rf-file"></label>' +
        '<div class="field"><label for="rf-url">или ссылка на изображение</label><input id="rf-url" type="url" placeholder="https://…"></div>' +
        '<p class="photo-status muted small" aria-live="polite"></p>' +
        '<button type="button" class="btn btn-ghost" data-a="nophoto">Убрать фото</button></div></div></fieldset>' +
        '<fieldset class="form-section"><legend>Ингредиенты <span class="req" aria-hidden="true">*</span></legend>' +
        '<div class="ing-rows"></div><button type="button" class="btn btn-secondary" data-a="add-ing">＋ Ингредиент</button>' +
        '<p class="field-error" id="rf-ing-err" hidden></p></fieldset>' +
        '<fieldset class="form-section"><legend>Шаги приготовления</legend><ol class="step-rows"></ol>' +
        '<button type="button" class="btn btn-secondary" data-a="add-step">＋ Шаг</button></fieldset>' +
        '<div class="form-summary" aria-live="polite"></div>' +
        '</form>');

      $('#rf-title', form).value = d.title;
      $('#rf-servings', form).value = d.servings;
      $('#rf-cuisine', form).value = d.cuisine || '';
      $('#rf-tags', form).value = (d.tags || []).join(', ');
      $$('input[name="meal"]', form).forEach(function (c) { c.checked = d.meals.indexOf(c.value) >= 0; });

      /* Фото: файл → сжатие → IndexedDB; ссылка → пробуем сохранить локальную копию */
      var origPhotoId = src ? src.photoId || null : null;
      var newPhotoIds = [];          // фото, созданные в этой форме (удалим, если не понадобятся)
      var photoToken = 0;            // защита от гонок при смене ссылки
      function hasPhoto() { return !!(d.photoId || d.photo || d.photoUrl); }
      function setStatus(t) { $('.photo-status', form).textContent = t || ''; }
      function renderPhoto() {
        $('.photo-preview', form).innerHTML = UI.mediaHtml({ title: $('#rf-title', form).value, photo: d.photo, photoId: d.photoId, photoUrl: d.photoUrl, meals: d.meals }, 'photo-media');
        $('[data-a="nophoto"]', form).hidden = !hasPhoto();
      }
      $('#rf-file', form).addEventListener('change', function (e) {
        var file = e.target.files[0]; if (!file) return;
        e.target.value = '';
        var token = ++photoToken;
        setStatus('Сжимаю фото…');
        Recipes.compressImage(file, 800, 0.75).then(function (blob) {
          if (token !== photoToken) return null;
          if (PhotoStore.isAvailable()) {
            return PhotoStore.put(blob, { source: 'upload' }).then(function (pid) {
              newPhotoIds.push(pid);
              if (token !== photoToken) return;
              d.photoId = pid; d.photo = null; d.photoUrl = null; d.photoCredit = null;
              $('#rf-url', form).value = '';
              setStatus('Фото сохранено на устройстве (' + Math.round(blob.size / 1024) + ' КБ).');
              renderPhoto();
            });
          }
          return PhotoStore.blobToDataURL(blob).then(function (dataUrl) {
            if (token !== photoToken) return;
            d.photo = dataUrl; d.photoId = null; d.photoUrl = null; d.photoCredit = null;
            $('#rf-url', form).value = '';
            setStatus('Фото сжато до ' + Math.round(blob.size / 1024) + ' КБ.');
            renderPhoto();
          });
        }).catch(function (err) { setStatus(''); UI.toast(err.message || String(err), { type: 'error' }); });
      });
      $('#rf-url', form).addEventListener('change', function (e) {
        var v = e.target.value.trim();
        if (v && !/^https?:\/\//i.test(v)) { UI.fieldError(e.target, 'Ссылка должна начинаться с http:// или https://'); return; }
        UI.fieldError(e.target, null);
        var token = ++photoToken;
        d.photoUrl = v || null; d.photoId = null; d.photo = null; d.photoCredit = null; delete d.photoCopyFailedAt;
        renderPhoto();
        if (!v) { setStatus(''); return; }
        if (!PhotoStore.isAvailable()) { setStatus('Фото будет загружаться по ссылке (нужен интернет).'); return; }
        setStatus('Пробую сохранить копию фото на устройство…');
        PhotoStore.fetchCopy(v).then(function (blob) {
          return PhotoStore.put(blob, { source: 'url', url: v }).then(function (pid) {
            newPhotoIds.push(pid);
            if (token !== photoToken) return;
            d.photoId = pid;
            setStatus('✓ Копия сохранена (' + Math.round(blob.size / 1024) + ' КБ) — фото будет видно и без интернета.');
            renderPhoto();
          });
        }).catch(function () {
          if (token !== photoToken) return;
          setStatus('Сайт не разрешает сохранить копию — фото будет загружаться по ссылке (нужен интернет).');
        });
      });
      $('[data-a="nophoto"]', form).addEventListener('click', function () {
        photoToken++;
        d.photo = null; d.photoId = null; d.photoUrl = null; d.photoCredit = null;
        $('#rf-url', form).value = ''; setStatus(''); renderPhoto();
      });
      if (d.photoUrl) $('#rf-url', form).value = d.photoUrl;
      if (d.photoId && d.photoUrl) setStatus('Локальная копия фото по ссылке сохранена на устройстве.' + (d.photoCredit ? ' Источник: ' + d.photoCredit.source + '.' : ''));
      else if (d.photoUrl && d.photoCredit) setStatus('Фото по умолчанию: ' + d.photoCredit.source + '. Можно заменить своим.');
      renderPhoto();
      /* После сохранения/отмены удаляем фото, которые больше не нужны */
      function cleanupPhotos() {
        // удаляем только фото, на которые больше не ссылается ни один сохранённый рецепт (в т. ч. черновик)
        var ref = {};
        DB.state.recipes.forEach(function (r) { if (r.photoId) ref[r.photoId] = true; });
        newPhotoIds.concat(origPhotoId ? [origPhotoId] : []).forEach(function (pid) { if (!ref[pid]) PhotoStore.remove(pid); });
      }

      /* Ингредиенты */
      var ingBox = $('.ing-rows', form);
      function ingRow(ing) {
        var p = ing.productId ? DB.product(ing.productId) : null;
        var nameId = UI.nextId('ing-name');
        var row = h('<div class="ing-row">' +
          '<div class="field ing-name"><label class="sr-only" for="' + nameId + '">Продукт</label><input id="' + nameId + '" type="text" placeholder="Продукт"></div>' +
          '<div class="field ing-amount"><label class="sr-only">Количество</label><input type="text" inputmode="decimal" placeholder="Сколько" aria-label="Количество"></div>' +
          '<div class="field ing-unit"><select aria-label="Единица">' + unitOptions(ing.unit || 'г') + '</select></div>' +
          '<button type="button" class="icon-btn" data-a="del-ing" aria-label="Удалить ингредиент">✕</button>' +
          '<div class="ing-note"></div><div class="ing-extra"></div></div>');
        row._ing = ing;
        var nameIn = $('.ing-name input', row), amtIn = $('.ing-amount input', row), unitSel = $('select', row);
        nameIn.value = p ? p.name : (ing._name || '');
        amtIn.value = ing.amount === '' || ing.amount == null ? '' : String(ing.amount).replace('.', ',');
        function syncAmountState() {
          var skip = ing.unit === 'по вкусу';
          amtIn.disabled = skip;
          if (skip) amtIn.value = '';
        }
        UI.autocomplete(nameIn, {
          source: UI.productSource,
          onPick: function (it) { ing.productId = it.id; ing._name = ''; nameIn.value = it.label; UI.fieldError(nameIn, null); closeExtra(); updateRow(); amtIn.focus(); },
          onCreate: function (q) { openNewProduct(q); },
          createLabel: function (q) { return '＋ Новый продукт «' + q + '»'; }
        });
        nameIn.addEventListener('input', function () {
          ing.productId = null; ing._name = nameIn.value; updateRow(false);
        });
        nameIn.addEventListener('blur', function () {
          setTimeout(function () {
            if (!ing.productId && nameIn.value.trim()) {
              var ex = DB.findProductByName(nameIn.value);
              if (ex) { ing.productId = ex.id; nameIn.value = ex.name; }
              updateRow();
            }
          }, 150);
        });
        amtIn.addEventListener('input', function () { ing.amount = amtIn.value; UI.fieldError(amtIn, null); updateSummary(); });
        unitSel.addEventListener('change', function () { ing.unit = unitSel.value; syncAmountState(); updateRow(); });
        $('[data-a="del-ing"]', row).addEventListener('click', function () {
          var i = d.ingredients.indexOf(ing);
          if (i >= 0) d.ingredients.splice(i, 1);
          row.remove();
          if (!d.ingredients.length) addIng();
          updateSummary();
        });
        function closeExtra() { $('.ing-extra', row).innerHTML = ''; }
        function openNewProduct(name) {
          var extra = $('.ing-extra', row);
          var needUnit = ['шт', 'ст. л.', 'ч. л.', 'мл', 'л'].indexOf(ing.unit) >= 0;
          extra.innerHTML = '';
          var box = h('<div class="mini-form" role="group" aria-label="Новый продукт">' +
            '<p class="mini-title">Новый продукт в справочник</p><div class="mini-grid">' +
            '<div class="field field-wide"><label>Название</label><input data-k="name" type="text"></div>' +
            '<div class="field field-wide"><label>Категория</label><select data-k="category">' + catOptions('other') + '</select></div>' +
            [['kcal', 'Ккал'], ['protein', 'Белки, г'], ['fat', 'Жиры, г'], ['carbs', 'Углеводы, г'], ['fiber', 'Клетчатка, г']].map(function (x) {
              return '<div class="field"><label>' + x[1] + ' <span class="muted">/100 г</span></label><input data-k="' + x[0] + '" type="text" inputmode="decimal" placeholder="0"></div>';
            }).join('') +
            (needUnit ? '<div class="field"><label>' + unitWeightLabel(ing.unit) + '</label><input data-k="unitw" type="text" inputmode="decimal"></div>' : '') +
            '</div><div class="btn-row"><button type="button" class="btn btn-ghost" data-m="cancel">Отмена</button><button type="button" class="btn btn-primary" data-m="save">Сохранить продукт</button></div></div>');
          // привязываем label к input
          $$('.field', box).forEach(function (fld) { var inp = $('input,select', fld), lb = $('label', fld); if (inp && lb) { inp.id = UI.nextId('np'); lb.setAttribute('for', inp.id); } });
          $('[data-k="name"]', box).value = name;
          extra.appendChild(box);
          $('[data-k="kcal"]', box).focus();
          $('[data-m="cancel"]', box).addEventListener('click', function () { closeExtra(); nameIn.focus(); });
          $('[data-m="save"]', box).addEventListener('click', function () {
            var ok = true;
            var nm = $('[data-k="name"]', box);
            if (!nm.value.trim()) ok = UI.fieldError(nm, 'Введите название') && ok;
            else if (DB.findProductByName(nm.value)) ok = UI.fieldError(nm, 'Такой продукт уже есть в справочнике') && ok;
            else UI.fieldError(nm, null);
            var per = {};
            ['kcal', 'protein', 'fat', 'carbs', 'fiber'].forEach(function (k) {
              var inp = $('[data-k="' + k + '"]', box);
              var v = inp.value.trim() === '' ? 0 : U.parseNum(inp.value);
              if (isNaN(v) || v < 0 || (k !== 'kcal' && v > 100) || v > 900) { ok = UI.fieldError(inp, 'Число от 0' + (k === 'kcal' ? ' до 900' : ' до 100')) && ok; }
              else { UI.fieldError(inp, null); per[k] = v; }
            });
            var units = {};
            var uw = $('[data-k="unitw"]', box);
            if (uw) {
              var w = U.parseNum(uw.value);
              if (uw.value.trim() !== '' && (isNaN(w) || w <= 0)) ok = UI.fieldError(uw, 'Число больше 0') && ok;
              else { UI.fieldError(uw, null); if (w > 0) units[unitKey(ing.unit)] = w; }
            }
            if (!ok) { var inv = $('[aria-invalid="true"]', box); if (inv) inv.focus(); return; }
            var prod = { id: U.uid('p'), name: nm.value.trim(), category: $('[data-k="category"]', box).value, per100: per, units: units, isCustom: true };
            DB.state.products.push(prod);
            if (!DB.save('products')) return;
            ing.productId = prod.id; ing._name = '';
            nameIn.value = prod.name;
            UI.fieldError(nameIn, null);
            closeExtra(); updateRow();
            UI.toast('Продукт «' + prod.name + '» добавлен в справочник');
            amtIn.focus();
          });
        }
        function updateRow(full) {
          var note = $('.ing-note', row);
          note.innerHTML = '';
          var pr = ing.productId ? DB.product(ing.productId) : null;
          if (pr && full !== false) {
            var g = Nutrition.toGrams(1, ing.unit, pr);
            if (g.status === 'missing') {
              var uid = UI.nextId('uw');
              var warn = h('<div class="ing-warn" role="alert"><span>⚠ Для «' + U.esc(pr.name) + '» не задан ' + (unitKey(ing.unit) === 'мл' ? 'вес 1 мл (плотность)' : 'вес единицы «' + U.esc(ing.unit) + '»') + ' — КБЖУ не посчитается.</span>' +
                '<label for="' + uid + '">' + unitWeightLabel(ing.unit) + '</label><input id="' + uid + '" type="text" inputmode="decimal" class="input-sm"><button type="button" class="btn btn-secondary btn-sm">Сохранить</button></div>');
              $('button', warn).addEventListener('click', function () {
                var inp = $('input', warn); var w = U.parseNum(inp.value);
                if (!(w > 0)) { inp.setAttribute('aria-invalid', 'true'); inp.focus(); return; }
                pr.units = pr.units || {}; pr.units[unitKey(ing.unit)] = w;
                DB.save('products');
                UI.toast('Вес единицы сохранён в справочнике');
                updateRow();
              });
              note.appendChild(warn);
            } else if (g.status === 'ok' && ing.unit !== 'г' && ing.unit !== 'кг') {
              var amt = U.parseNum(ing.amount);
              if (amt > 0) note.appendChild(h('<span class="muted small">≈ ' + U.fmt(Nutrition.toGrams(amt, ing.unit, pr).grams) + ' г</span>'));
            }
          }
          updateSummary();
        }
        syncAmountState();
        amtIn.addEventListener('change', function () { updateRow(); });
        setTimeout(function () { updateRow(); }, 0);
        return row;
      }
      function addIng(focus) {
        var ing = { productId: null, amount: '', unit: 'г' };
        d.ingredients.push(ing);
        var row = ingRow(ing);
        ingBox.appendChild(row);
        if (focus) $('input', row).focus();
      }
      d.ingredients.forEach(function (ing) { ingBox.appendChild(ingRow(ing)); });
      $('[data-a="add-ing"]', form).addEventListener('click', function () { addIng(true); });

      /* Шаги (drag&drop через SortableJS + кнопки ↑/↓ для клавиатуры) */
      var stepBox = $('.step-rows', form);
      function renderSteps(focusIdx) {
        stepBox.innerHTML = '';
        d.steps.forEach(function (s, i) {
          var li = h('<li class="step-row"><span class="drag-handle" aria-hidden="true" title="Перетащите">⋮⋮</span>' +
            '<textarea rows="2" aria-label="Шаг ' + (i + 1) + '"></textarea><div class="step-ctrls">' +
            '<button type="button" class="icon-btn" data-s="up" aria-label="Переместить шаг ' + (i + 1) + ' выше"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
            '<button type="button" class="icon-btn" data-s="down" aria-label="Переместить шаг ' + (i + 1) + ' ниже"' + (i === d.steps.length - 1 ? ' disabled' : '') + '>↓</button>' +
            '<button type="button" class="icon-btn" data-s="del" aria-label="Удалить шаг ' + (i + 1) + '">✕</button></div></li>');
          var ta = $('textarea', li); ta.value = s;
          ta.addEventListener('input', function () { d.steps[i] = ta.value; });
          li.addEventListener('click', function (e) {
            var b = e.target.closest('[data-s]'); if (!b) return;
            var a = b.dataset.s;
            if (a === 'del') { d.steps.splice(i, 1); if (!d.steps.length) d.steps.push(''); renderSteps(Math.max(0, i - 1)); }
            if (a === 'up' && i > 0) { var t = d.steps[i - 1]; d.steps[i - 1] = d.steps[i]; d.steps[i] = t; renderSteps(i - 1, 'up'); }
            if (a === 'down' && i < d.steps.length - 1) { var t2 = d.steps[i + 1]; d.steps[i + 1] = d.steps[i]; d.steps[i] = t2; renderSteps(i + 1, 'down'); }
          });
          stepBox.appendChild(li);
        });
        if (focusIdx != null) {
          var li = stepBox.children[focusIdx];
          var which = arguments[1];
          var target = which ? $('[data-s="' + which + '"]', li) : null;
          if (!target || target.disabled) target = $('textarea', li);
          if (target) target.focus();
        }
      }
      renderSteps();
      if (global.Sortable) {
        global.Sortable.create(stepBox, {
          handle: '.drag-handle', animation: 150,
          onEnd: function (ev) {
            if (ev.oldIndex === ev.newIndex) return;
            var moved = d.steps.splice(ev.oldIndex, 1)[0];
            d.steps.splice(ev.newIndex, 0, moved); dirty = true;
            renderSteps();
          }
        });
      } else {
        Lib.loadSortable().then(function (S) {
          if (!S || !document.contains(stepBox)) return;
          S.create(stepBox, { handle: '.drag-handle', animation: 150, onEnd: function (ev) {
            if (ev.oldIndex === ev.newIndex) return;
            var moved = d.steps.splice(ev.oldIndex, 1)[0]; d.steps.splice(ev.newIndex, 0, moved); dirty = true; renderSteps();
          } });
        });
      }
      $('[data-a="add-step"]', form).addEventListener('click', function () { d.steps.push(''); renderSteps(d.steps.length - 1); });

      /* Итоги КБЖУ в реальном времени */
      function draftRecipe() {
        return { servings: Math.max(1, parseInt($('#rf-servings', form).value, 10) || 1),
          ingredients: d.ingredients.filter(function (i) { return i.productId; }).map(function (i) { return { productId: i.productId, amount: U.parseNum(i.amount) || 0, unit: i.unit }; }) };
      }
      function updateSummary() {
        var ps = Nutrition.perServing(draftRecipe());
        $('.form-summary', form).innerHTML = '<div class="summary-line"><strong>На порцию:</strong> ' + U.fmt(ps.kcal) + ' ккал · Б ' + U.fmt(ps.protein, 1) + ' · Ж ' + U.fmt(ps.fat, 1) +
          ' · У ' + U.fmt(ps.carbs, 1) + ' · клетчатка ' + U.fmt(ps.fiber, 1) + ' г</div>' + UI.macroBar(ps) + '<div class="badges">' + UI.badgesHtml(ps) + '</div>';
      }
      $('#rf-servings', form).addEventListener('input', updateSummary);
      $('#rf-title', form).addEventListener('change', renderPhoto);
      $$('input[name="meal"]', form).forEach(function (c) { c.addEventListener('change', function () { d.meals = $$('input[name="meal"]:checked', form).map(function (x) { return x.value; }); renderPhoto(); }); });
      updateSummary();

      var foot = h('<div class="btn-row"><button type="button" class="btn btn-ghost" data-close>Отмена</button>' +
        (draftMode ? '<button type="button" class="btn btn-secondary" data-a="draft">Сохранить черновик</button>' : '') +
        '<button type="submit" class="btn btn-primary" data-a="save">Сохранить</button></div>');
      var m = UI.modal({ title: src && src.draft ? 'Черновик рецепта' : (src ? 'Редактирование рецепта' : 'Новый рецепт'), content: form, footer: foot, size: 'lg', static: true,
        beforeClose: beforeClose, onClose: function () {
          document.removeEventListener('visibilitychange', onVisibility);
          global.removeEventListener('pagehide', autoSave);
          cleanupPhotos();
        } });

      /* ---------- Черновики: изменения, автосохранение, закрытие ---------- */
      function markDirty() { dirty = true; }
      form.addEventListener('input', markDirty);
      form.addEventListener('change', markDirty);
      form.addEventListener('click', function (e) { if (e.target.closest('[data-a="add-ing"], [data-a="del-ing"], [data-a="add-step"], [data-s], [data-a="nophoto"], [data-m="save"]')) markDirty(); });
      function collect(asDraft) {
        var n = parseInt($('#rf-servings', form).value, 10);
        var title = $('#rf-title', form).value.trim();
        var ings = [];
        $$('.ing-row', ingBox).forEach(function (row) {
          var i = row._ing, nm = $('.ing-name input', row).value.trim();
          var a = i.unit === 'по вкусу' ? 0 : U.parseNum(i.amount);
          if (i.productId) ings.push({ productId: i.productId, amount: isNaN(a) ? 0 : a, unit: i.unit });
          else if (asDraft && (nm || (!isNaN(a) && a > 0))) ings.push({ productId: null, name: nm, amount: isNaN(a) ? '' : a, unit: i.unit });
        });
        return { title: title, servings: n >= 1 ? Math.min(99, n) : (asDraft ? Number(d.servings) || 2 : n),
          photo: d.photo || null, photoId: d.photoId || null, photoUrl: d.photoUrl || null, photoCredit: d.photoCredit || null,
          meals: $$('input[name="meal"]:checked', form).map(function (x) { return x.value; }),
          cuisine: $('#rf-cuisine', form).value.trim(),
          tags: $('#rf-tags', form).value.split(',').map(function (x) { return x.trim(); }).filter(Boolean),
          ingredients: ings,
          steps: d.steps.map(function (x) { return x.trim(); }).filter(Boolean) };
      }
      /* Сохранить как черновик. Для готового рецепта — в отдельную копию (draftOf), сам рецепт не трогаем */
      function writeDraft() {
        var base = isPublished ? { id: copyId || (copyId = U.uid('r')), draftOf: src.id, createdAt: Date.now() } : (DB.recipe(d.id) || src || {});
        var out = Object.assign({}, base, collect(true), { id: isPublished ? copyId : d.id, draft: true });
        if (isPublished) out.draftOf = src.id;
        out.createdAt = out.createdAt || Date.now();
        return Recipes.upsert(out);
      }
      function autoSave() {
        if (!dirty || allowClose) return;
        if (writeDraft()) autoSaved = true;
      }
      function onVisibility() { if (document.visibilityState === 'hidden') autoSave(); }
      document.addEventListener('visibilitychange', onVisibility);
      global.addEventListener('pagehide', autoSave);
      /* «Не сохранять»: откатываем то, что успело записать автосохранение */
      function discardAutoSaved() {
        if (!autoSaved) return;
        if (isPublished) { if (copyId) Recipes.remove(copyId); }
        else if (snapshot) Recipes.upsert(snapshot);
        else Recipes.remove(d.id);
      }
      function saveDraftAndClose() {
        if (!writeDraft()) return;
        allowClose = true; m.close(); Router.refresh();
        UI.toast('Черновик «' + (collect(true).title || 'Без названия') + '» сохранён');
      }
      function beforeClose() {
        if (allowClose || !dirty) {
          // закрыли без изменений после автосохранения — ничего не теряем: черновик остаётся
          return true;
        }
        var opts = draftMode
          ? [{ value: 'draft', label: 'Сохранить черновик', desc: 'Рецепт появится в блоке «Черновики», его можно будет дописать позже', primary: true }]
          : [{ value: 'save', label: 'Сохранить изменения', desc: 'Проверим поля и обновим рецепт', primary: true }];
        opts.push({ value: 'discard', label: 'Не сохранять', desc: draftMode && src ? 'Черновик останется таким, каким был до открытия' : 'Изменения будут потеряны' });
        opts.push({ value: 'continue', label: 'Продолжить редактирование' });
        UI.choose({ title: 'Сохранить изменения?', options: opts }).then(function (v) {
          if (v === 'draft') saveDraftAndClose();
          else if (v === 'save') validateAndSave();
          else if (v === 'discard') { discardAutoSaved(); allowClose = true; m.close(); Router.refresh(); }
        });
        return false;
      }
      if (draftMode) foot.querySelector('[data-a="draft"]').addEventListener('click', saveDraftAndClose);

      function validateAndSave() {
        var ok = true, firstBad = null;
        function bad(el, msg) { UI.fieldError(el, msg); ok = false; if (!firstBad) firstBad = el; }
        var t = $('#rf-title', form);
        if (!t.value.trim()) bad(t, 'Введите название рецепта'); else UI.fieldError(t, null);
        var sv = $('#rf-servings', form); var n = Number(sv.value);
        if (!(n >= 1) || Math.floor(n) !== n) bad(sv, 'Число порций — целое, не меньше 1'); else UI.fieldError(sv, null);
        var rows = $$('.ing-row', ingBox);
        var filled = 0;
        rows.forEach(function (row) {
          var ing = row._ing, nameIn = $('.ing-name input', row), amtIn = $('.ing-amount input', row);
          var empty = !nameIn.value.trim() && !String(ing.amount || '').trim();
          if (empty && rows.length > 1) return;
          if (!ing.productId) {
            var ex = DB.findProductByName(nameIn.value);
            if (ex) { ing.productId = ex.id; nameIn.value = ex.name; }
          }
          if (!ing.productId) bad(nameIn, nameIn.value.trim() ? 'Выберите продукт из списка или создайте новый' : 'Укажите продукт');
          else UI.fieldError(nameIn, null);
          if (ing.unit !== 'по вкусу') {
            var a = U.parseNum(ing.amount);
            if (!(a > 0)) bad(amtIn, 'Количество должно быть больше 0'); else UI.fieldError(amtIn, null);
          }
          filled++;
        });
        var ingErr = $('#rf-ing-err', form);
        if (!filled) { ingErr.hidden = false; ingErr.textContent = 'Добавьте хотя бы один ингредиент'; ok = false; if (!firstBad) firstBad = $('.ing-name input', ingBox); }
        else ingErr.hidden = true;
        if (!ok) { if (firstBad) firstBad.focus(); UI.toast('Проверьте поля формы', { type: 'error', timeout: 2500 }); return; }
        // целевой рецепт: для копии-черновика — исходный рецепт (если он ещё есть)
        var target = origOf || (isPublished ? src : null);
        var rec = target || DB.recipe(d.id) || src || {};
        var out = Object.assign({}, rec, collect(false), { id: target ? target.id : d.id, draft: false, createdAt: rec.createdAt || Date.now() });
        delete out.draftOf;
        if (!Recipes.upsert(out)) return;
        if (copyId) Recipes.remove(copyId);                       // автосохранённая копия больше не нужна
        if (origOf && src && src.id !== out.id) Recipes.remove(src.id); // открыли копию-черновик — убираем её
        var wasDraft = !!(src && src.draft);
        allowClose = true;
        m.close();
        Router.refresh();
        UI.toast(isPublished || origOf ? 'Рецепт сохранён' : 'Рецепт «' + out.title + '» ' + (wasDraft ? 'сохранён — он появился в списке рецептов' : 'создан'));
      }
      foot.querySelector('[data-a="save"]').addEventListener('click', validateAndSave);
      form.addEventListener('submit', function (e) { e.preventDefault(); validateAndSave(); });
      form.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); validateAndSave(); }
        else if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault();
      });
    }

    return { render: render, openRecipe: openRecipe, openForm: openForm, catOptions: catOptions, unitOptions: unitOptions };
  })();

  /* =======================================================================
   * UI: Колесо фортуны — случайное блюдо из выбранной категории
   * ======================================================================= */
  var WheelView = (function () {
    var MAX_SECTORS = 12;
    var state = { meal: '', respectExcluded: true, rotation: 0, lastId: null };

    function randInt(n) {
      if (global.crypto && crypto.getRandomValues) {
        var a = new Uint32Array(1); crypto.getRandomValues(a);
        return a[0] % n;
      }
      return Math.floor(Math.random() * n);
    }
    function shuffle(arr) {
      var a = arr.slice();
      for (var i = a.length - 1; i > 0; i--) { var j = randInt(i + 1); var t = a[i]; a[i] = a[j]; a[j] = t; }
      return a;
    }
    function pool() {
      var rs = DB.state.settings.restrictions;
      var ex = state.respectExcluded ? rs.excluded : [];
      var diets = state.respectExcluded ? (rs.diets || []) : [];
      return Recipes.ready().filter(function (r) {
        if (state.meal && (r.meals || []).indexOf(state.meal) < 0) return false;
        if (!Diets.fitsAll(r, diets)) return false;
        return !Recipes.containsProduct(r, ex);
      });
    }
    /* На колесе максимум 12 секторов: если рецептов больше — берём случайные 12 */
    function pickSectors(list) {
      if (list.length <= MAX_SECTORS) return shuffle(list);
      return shuffle(list).slice(0, MAX_SECTORS);
    }
    function short(s, n) { return s.length > n ? s.slice(0, n - 1).trim() + '…' : s; }

    function wheelSvg(items) {
      var n = items.length, R = 150, cx = 160, cy = 160;
      var seg = 360 / n;
      var parts = [];
      function pt(angleDeg, r) {
        var a = (angleDeg - 90) * Math.PI / 180;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      }
      items.forEach(function (r, i) {
        var a0 = i * seg, a1 = (i + 1) * seg;
        var cls = i % 4;
        if (n % 4 === 1 && i === n - 1) cls = 2;       // соседние сектора не одного цвета
        if (n === 2) cls = i;
        var shape;
        if (n === 1) shape = '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" class="ws ws-0"/>';
        else {
          var p0 = pt(a0, R), p1 = pt(a1, R);
          shape = '<path class="ws ws-' + cls + '" d="M' + cx + ' ' + cy + ' L' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) +
            ' A' + R + ' ' + R + ' 0 ' + (seg > 180 ? 1 : 0) + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2) + ' Z"/>';
        }
        var mid = a0 + seg / 2;
        // только эмодзи — название откроется, когда стрелка остановится на секторе
        var es = n <= 4 ? 44 : n <= 6 ? 38 : n <= 9 ? 32 : 26;
        var ep = pt(mid, n === 1 ? 0 : R * 0.64);
        var ph = Recipes.placeholder(r);
        parts.push('<g class="wsec" data-i="' + i + '">' + shape +
          '<text class="we" font-size="' + es + '" text-anchor="middle" dominant-baseline="central" x="' + ep[0].toFixed(2) + '" y="' + ep[1].toFixed(2) + '"' +
          ' transform="rotate(' + mid.toFixed(2) + ' ' + ep[0].toFixed(2) + ' ' + ep[1].toFixed(2) + ')">' + ph.emoji + '</text></g>');
      });
      return '<svg viewBox="0 0 320 320" class="wheel-svg" aria-hidden="true" focusable="false">' +
        '<g class="wheel-rot" style="transform: rotate(' + state.rotation + 'deg)">' + parts.join('') +
        '<circle cx="160" cy="160" r="' + R + '" class="wheel-rim"/></g>' +
        '<circle cx="160" cy="160" r="26" class="wheel-hub"/><text x="160" y="166" text-anchor="middle" class="wheel-hub-t" font-size="16">🍽️</text></svg>';
    }

    /* Переключатель «учитывать ограничения из меню»: диеты и исключённые продукты */
    function wheelSwitchHtml() {
      var rs = DB.state.settings.restrictions, dn = Diets.names(rs.diets), exN = rs.excluded.length;
      if (!dn.length && !exN) return '';
      var parts = [];
      if (dn.length) parts.push((dn.length === 1 ? 'диету «' + dn[0] + '»' : 'диеты: ' + dn.join(', ')));
      if (exN) parts.push('исключённые продукты');
      return UI.switchHtml('wh-ex', 'Учитывать ' + parts.join(' и ') + ' из меню', state.respectExcluded);
    }
    function open() {
      var sectors = [];
      var spinning = false;
      var content = h('<div class="wheel">' +
        '<p class="muted small">Выберите, для какого приёма пищи ищете блюдо, и крутите колесо.</p>' +
        '<div class="chips" role="group" aria-label="Категория">' +
        '<button type="button" class="chip" data-meal="">Все</button>' +
        Models.MEALS.map(function (m) { return '<button type="button" class="chip" data-meal="' + m.id + '">' + m.emoji + ' ' + m.name + '</button>'; }).join('') +
        '</div>' +
        wheelSwitchHtml() +
        '<p class="wheel-now" aria-hidden="true"><span class="wn-emoji">❔</span><span class="wn-title">Крутите колесо — блюдо откроется здесь</span></p>' +
        '<div class="wheel-stage"><div class="wheel-pointer" aria-hidden="true"></div><div class="wheel-box"></div></div>' +
        '<p class="wheel-note muted small" aria-live="polite"></p>' +
        '<div class="btn-row wheel-actions"><button type="button" class="btn btn-ghost" data-w="shuffle">Перемешать</button>' +
        '<button type="button" class="btn btn-primary btn-spin" data-w="spin">Крутить!</button></div>' +
        '<div class="wheel-result" aria-live="assertive"></div></div>');
      var box = $('.wheel-box', content), note = $('.wheel-note', content), result = $('.wheel-result', content);
      var spinBtn = $('[data-w="spin"]', content), shuffleBtn = $('[data-w="shuffle"]', content);

      function build() {
        var list = pool();
        result.innerHTML = '';
        $$('.chip', content).forEach(function (c) { c.setAttribute('aria-pressed', String(c.dataset.meal === state.meal)); });
        if (!list.length) {
          sectors = [];
          box.innerHTML = '';
          box.appendChild(UI.emptyState({ emoji: '🤷', title: 'Нет рецептов в этой категории', text: 'Добавьте рецепт с нужным типом приёма пищи или выберите другую категорию.' }));
          note.textContent = '';
          spinBtn.disabled = true; shuffleBtn.hidden = true;
          return;
        }
        sectors = pickSectors(list);
        box.innerHTML = wheelSvg(sectors);
        box.setAttribute('role', 'img');
        box.setAttribute('aria-label', 'Колесо с ' + sectors.length + ' ' + U.plural(sectors.length, 'блюдом', 'блюдами', 'блюдами') + '. Название откроется после вращения.');
        setNow(null);
        spinBtn.disabled = false;
        shuffleBtn.hidden = list.length <= MAX_SECTORS;
        note.textContent = list.length > MAX_SECTORS
          ? 'На колесе ' + MAX_SECTORS + ' случайных блюд из ' + list.length + '. Кнопка «Перемешать» соберёт другой набор.'
          : 'На колесе ' + list.length + ' ' + U.plural(list.length, 'блюдо', 'блюда', 'блюд') + '.';
      }
      var nowEl = $('.wheel-now', content), rafId = 0;
      function setNow(r, final) {
        $('.wn-emoji', nowEl).textContent = r ? Recipes.placeholder(r).emoji : '❔';
        $('.wn-title', nowEl).textContent = r ? r.title : 'Крутите колесо — блюдо откроется здесь';
        nowEl.classList.toggle('is-final', !!final);
        nowEl.classList.toggle('is-idle', !r);
      }
      /* Во время вращения показываем блюдо, которое сейчас под стрелкой */
      function track() {
        var rot = $('.wheel-rot', box); if (!rot) return;
        var m = /matrix\(([^,]+),\s*([^,]+)/.exec(getComputedStyle(rot).transform || '');
        if (m) {
          var ang = Math.atan2(parseFloat(m[2]), parseFloat(m[1])) * 180 / Math.PI;
          var r = sectors[sectorAt(ang, sectors.length)];
          if (r && $('.wn-title', nowEl).textContent !== r.title) setNow(r);
        }
        if (spinning) rafId = requestAnimationFrame(track);
      }
      function spin() {
        if (spinning || !sectors.length) return;
        var n = sectors.length;
        var idx = randInt(n);
        if (n > 2 && sectors[idx].id === state.lastId) idx = (idx + 1 + randInt(n - 1)) % n; // не повторяем прошлый выбор подряд
        var seg = 360 / n;
        var center = idx * seg + seg / 2;
        var jitter = (randInt(1000) / 1000 - 0.5) * seg * 0.6;
        var reduce = global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
        var cur = state.rotation;
        var target = ((360 - center - jitter) % 360 + 360) % 360;
        var delta = ((target - (cur % 360)) % 360 + 360) % 360;
        state.rotation = cur + delta + (reduce ? 0 : 360 * (5 + randInt(3)));
        var rot = $('.wheel-rot', box);
        spinning = true;
        spinBtn.disabled = true; shuffleBtn.disabled = true;
        $$('.chip', content).forEach(function (c) { c.disabled = true; });
        result.innerHTML = '';
        box.classList.remove('has-winner');
        $$('.wsec', box).forEach(function (g) { g.classList.remove('is-winner'); });
        var dur = reduce ? 0 : 4200 + randInt(800);
        rot.style.transition = reduce ? 'none' : 'transform ' + dur + 'ms cubic-bezier(.12,.7,.12,1)';
        // force reflow, затем поворот
        void rot.getBoundingClientRect();
        rot.style.transform = 'rotate(' + state.rotation + 'deg)';
        if (dur) { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(track); }
        setTimeout(function () { finish(idx); }, dur + 60);
      }
      function finish(idx) {
        spinning = false;
        spinBtn.disabled = false; shuffleBtn.disabled = false;
        spinBtn.textContent = 'Крутить ещё';
        $$('.chip', content).forEach(function (c) { c.disabled = false; });
        cancelAnimationFrame(rafId);
        var r = sectors[idx];
        state.lastId = r.id;
        setNow(r, true);
        var g = $('.wsec[data-i="' + idx + '"]', box);
        if (g) g.classList.add('is-winner');
        box.classList.add('has-winner');
        showResult(r);
      }
      function showResult(r) {
        var ps = Nutrition.perServing(r);
        var portions = r.servings;
        result.innerHTML = '';
        var card = h('<div class="wheel-card"><div class="wc-media">' + UI.mediaHtml(r, 'wc-img') + '</div>' +
          '<div class="wc-body"><p class="wc-kicker">Сегодня готовим</p><h3 class="wc-title"></h3>' +
          '<p class="muted small">' + U.fmt(ps.kcal) + ' ккал · Б ' + U.fmt(ps.protein) + ' · Ж ' + U.fmt(ps.fat) + ' · У ' + U.fmt(ps.carbs) + ' на порцию · ' +
          r.ingredients.length + ' ' + U.plural(r.ingredients.length, 'ингредиент', 'ингредиента', 'ингредиентов') + '</p>' +
          '<div class="badges">' + UI.badgesHtml(ps) + '</div>' +
          '<div class="wc-actions"><div class="stepper stepper-sm" role="group" aria-label="Порций в список покупок">' +
          '<button type="button" class="icon-btn" data-p="-1" aria-label="Меньше порций">−</button><span class="stepper-val"></span>' +
          '<button type="button" class="icon-btn" data-p="1" aria-label="Больше порций">+</button></div>' +
          '<button type="button" class="btn btn-secondary btn-sm" data-r="shop">В список покупок</button>' +
          '<button type="button" class="btn btn-primary btn-sm" data-r="open">Открыть рецепт</button></div></div></div>');
        $('.wc-title', card).textContent = r.title;
        function sync() { $('.stepper-val', card).textContent = portions + ' ' + U.plural(portions, 'порция', 'порции', 'порций'); $('[data-p="-1"]', card).disabled = portions <= 1; }
        sync();
        card.addEventListener('click', function (e) {
          var b = e.target.closest('[data-p],[data-r]'); if (!b) return;
          if (b.dataset.p) { portions = Math.max(1, Math.min(99, portions + Number(b.dataset.p))); sync(); return; }
          if (b.dataset.r === 'open') { m.close(); setTimeout(function () { RecipesView.openRecipe(r.id); }, 170); }
          if (b.dataset.r === 'shop') {
            Shopping.addRecipe(r, portions, 'recipe');
            if (DB.save('shopping')) UI.toast('«' + r.title + '» ×' + portions + ' → в списке покупок', { actionLabel: 'Открыть список', onAction: function () { m.close(); location.hash = '#shopping'; } });
          }
        });
        result.appendChild(card);
        $('[data-r="open"]', card).focus({ preventScroll: true });
        card.scrollIntoView({ block: 'nearest', behavior: global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
      $$('.chip', content).forEach(function (c) {
        c.addEventListener('click', function () { if (spinning) return; state.meal = c.dataset.meal; spinBtn.textContent = 'Крутить!'; build(); });
      });
      var sw = $('#wh-ex', content);
      if (sw) sw.addEventListener('click', function () {
        if (spinning) return;
        state.respectExcluded = !state.respectExcluded; sw.setAttribute('aria-checked', String(state.respectExcluded)); build();
      });
      spinBtn.addEventListener('click', spin);
      shuffleBtn.addEventListener('click', function () { if (!spinning) { build(); } });
      box.addEventListener('click', spin);
      var m = UI.modal({ title: 'Колесо фортуны', content: content, size: 'md' });
      build();
      setTimeout(function () { if (!spinBtn.disabled) spinBtn.focus(); }, 40);
      return m;
    }
    /* Для тестов: выбор сектора по углу поворота */
    function sectorAt(rotation, n) {
      var a = ((360 - (rotation % 360)) % 360 + 360) % 360;
      return Math.floor(a / (360 / n)) % n;
    }
    return { open: open, sectorAt: sectorAt, _state: state };
  })();
  Foodly.WheelView = WheelView;

  /* =======================================================================
   * UI: Список покупок
   * ======================================================================= */
  var ShoppingView = (function () {
    var root = null;
    function render() {
      root = h('<section class="view" aria-labelledby="h-shop">' +
        '<div class="view-head"><div><h1 id="h-shop" tabindex="-1">Список покупок</h1><p class="muted" id="shop-count"></p></div>' +
        '<div class="btn-row wrap"><button type="button" class="btn btn-primary" data-a="pdf">Экспорт в PDF</button>' +
        '<button type="button" class="btn btn-secondary" data-a="clear-checked">Убрать купленное</button>' +
        '<button type="button" class="btn btn-ghost btn-danger-text" data-a="clear-all">Очистить список</button></div></div>' +
        '<form class="card add-item" novalidate aria-label="Добавить продукт в список">' +
        '<div class="field ai-name"><label for="ai-name">Продукт</label><input id="ai-name" type="text" placeholder="Например, молоко" maxlength="80"></div>' +
        '<div class="field ai-amount"><label for="ai-amount">Количество</label><input id="ai-amount" type="text" inputmode="decimal" placeholder="1"></div>' +
        '<div class="field ai-unit"><label for="ai-unit">Единица</label><select id="ai-unit">' + RecipesView.unitOptions('шт') + '</select></div>' +
        '<div class="field ai-cat"><label for="ai-cat">Категория</label><select id="ai-cat">' + RecipesView.catOptions('other') + '</select></div>' +
        '<button type="submit" class="btn btn-primary ai-submit">Добавить</button></form>' +
        '<div id="shop-groups"></div></section>');
      var picked = null;
      var nameIn = $('#ai-name', root);
      UI.autocomplete(nameIn, {
        source: UI.productSource,
        onPick: function (it) {
          picked = it.product; nameIn.value = it.label;
          $('#ai-cat', root).value = it.product.category;
          var u = it.product.units || {};
          $('#ai-unit', root).value = u['шт'] ? 'шт' : (u['мл'] ? 'мл' : 'г');
          $('#ai-amount', root).focus();
        }
      });
      nameIn.addEventListener('input', function () {
        picked = null;
        var ex = DB.findProductByName(nameIn.value);
        if (ex) $('#ai-cat', root).value = ex.category;
      });
      $('.add-item', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var ok = true;
        var name = nameIn.value.trim();
        if (!name) ok = UI.fieldError(nameIn, 'Введите название') && ok; else UI.fieldError(nameIn, null);
        var unit = $('#ai-unit', root).value;
        var amtIn = $('#ai-amount', root);
        var amt = amtIn.value.trim() === '' ? 1 : U.parseNum(amtIn.value);
        if (unit !== 'по вкусу' && !(amt > 0)) ok = UI.fieldError(amtIn, 'Больше 0') && ok; else UI.fieldError(amtIn, null);
        if (!ok) { $('[aria-invalid="true"]', root).focus(); return; }
        var prod = picked || DB.findProductByName(name);
        Shopping.addItem(DB.state.shopping, { productId: prod ? prod.id : null, name: name, amount: amt, unit: unit, category: $('#ai-cat', root).value, source: 'manual' }, null);
        if (!DB.save('shopping')) return;
        UI.toast('«' + (prod ? prod.name : name) + '» добавлено');
        nameIn.value = ''; amtIn.value = ''; picked = null;
        nameIn.focus();
        updateList();
      });
      $('[data-a="pdf"]', root).addEventListener('click', openPdfDialog);
      $('[data-a="clear-checked"]', root).addEventListener('click', function () {
        var before = DB.state.shopping.slice();
        var n = before.filter(function (x) { return x.checked; }).length;
        if (!n) { UI.toast('Купленных позиций нет'); return; }
        DB.state.shopping = DB.state.shopping.filter(function (x) { return !x.checked; });
        DB.save('shopping'); updateList();
        UI.toast('Убрано купленных: ' + n, { actionLabel: 'Отменить', onAction: function () { DB.state.shopping = before; DB.save('shopping'); updateList(); } });
      });
      $('[data-a="clear-all"]', root).addEventListener('click', function () {
        if (!DB.state.shopping.length) { UI.toast('Список уже пуст'); return; }
        UI.confirm({ title: 'Очистить список?', text: 'Все ' + DB.state.shopping.length + ' позиций будут удалены из списка покупок.', okText: 'Очистить', danger: true }).then(function (yes) {
          if (!yes) return;
          var before = DB.state.shopping.slice();
          DB.state.shopping = [];
          DB.save('shopping'); updateList();
          UI.toast('Список очищен', { actionLabel: 'Отменить', onAction: function () { DB.state.shopping = before; DB.save('shopping'); updateList(); } });
        });
      });
      var groupsBox = $('#shop-groups', root);
      groupsBox.addEventListener('change', function (e) {
        var li = e.target.closest('[data-id]'); if (!li) return;
        var it = DB.state.shopping.filter(function (x) { return x.id === li.dataset.id; })[0]; if (!it) return;
        if (e.target.matches('.shop-check')) {
          it.checked = e.target.checked; DB.save('shopping'); updateList(it.id, '.shop-check');
        } else if (e.target.matches('.qty-input') || e.target.matches('.qty-unit')) {
          var inp = $('.qty-input', li), sel = $('.qty-unit', li);
          var v = U.parseNum(inp.value);
          if (!(v > 0)) { inp.setAttribute('aria-invalid', 'true'); UI.toast('Количество должно быть больше 0', { type: 'error', timeout: 2500 }); return; }
          inp.removeAttribute('aria-invalid');
          var b = Shopping.toBase(v, sel.value, it.productId ? DB.product(it.productId) : null);
          it.amount = b.amount; it.unit = b.unit;
          DB.save('shopping'); updateList(it.id, e.target.matches('.qty-unit') ? '.qty-unit' : '.qty-input');
        }
      });
      groupsBox.addEventListener('click', function (e) {
        var b = e.target.closest('[data-del]'); if (!b) return;
        var i = DB.state.shopping.findIndex(function (x) { return x.id === b.dataset.del; });
        if (i < 0) return;
        var removed = DB.state.shopping.splice(i, 1)[0];
        DB.save('shopping'); updateList();
        UI.toast('«' + removed.name + '» удалено', { actionLabel: 'Отменить', onAction: function () {
          DB.state.shopping.splice(Math.min(i, DB.state.shopping.length), 0, removed); DB.save('shopping'); updateList();
        } });
      });
      updateList();
      return root;
    }
    function qtyControls(it) {
      if (it.unit === 'по вкусу') return '<span class="qty-text">по вкусу</span>';
      var unit = it.unit, val = it.amount;
      var opts = [unit];
      if (unit === 'г') { opts = ['г', 'кг']; if (val >= 1000) { unit = 'кг'; val = val / 1000; } }
      else if (unit === 'мл') { opts = ['мл', 'л']; if (val >= 1000) { unit = 'л'; val = val / 1000; } }
      var shown = unit === 'г' || unit === 'мл' ? Math.round(val) : U.round(val, unit === 'шт' ? 1 : 2);
      if (unit === 'шт') shown = Math.ceil(val * 2 - 1e-9) / 2;
      return '<input class="qty-input" type="text" inputmode="decimal" value="' + String(shown).replace('.', ',') + '" aria-label="Количество: ' + U.esc(it.name) + '">' +
        '<select class="qty-unit" aria-label="Единица: ' + U.esc(it.name) + '">' + opts.map(function (u) { return '<option' + (u === unit ? ' selected' : '') + '>' + u + '</option>'; }).join('') + '</select>';
    }
    function updateList(focusId, focusSel) {
      if (!root) return;
      var list = DB.state.shopping;
      var box = $('#shop-groups', root);
      var left = list.filter(function (x) { return !x.checked; }).length;
      $('#shop-count', root).textContent = list.length ? 'Осталось купить ' + left + ' из ' + list.length : '';
      $$('.view-head .btn', root).forEach(function (b) { b.disabled = !list.length; });
      box.innerHTML = '';
      if (!list.length) {
        box.appendChild(UI.emptyState({ emoji: '🛒', title: 'Список покупок пуст', text: 'Добавьте продукт в форме выше, отправьте ингредиенты из рецепта или добавьте продукты из меню на неделю.',
          actionLabel: 'Выбрать рецепт', onAction: function () { location.hash = '#recipes'; } }));
        return;
      }
      box.innerHTML = Shopping.grouped(list).map(function (g) {
        var gid = 'g-' + g.id;
        return '<section class="shop-group card" aria-labelledby="' + gid + '"><h2 class="shop-group-title" id="' + gid + '">' + U.esc(g.name) +
          ' <span class="count">' + g.items.filter(function (x) { return !x.checked; }).length + '/' + g.items.length + '</span></h2><ul class="shop-items">' +
          g.items.map(function (it) {
            var cid = 'chk-' + it.id;
            var refs = Shopping.refsLabel(it);
            return '<li class="shop-item' + (it.checked ? ' is-checked' : '') + '" data-id="' + U.esc(it.id) + '">' +
              '<input type="checkbox" class="shop-check" id="' + cid + '"' + (it.checked ? ' checked' : '') + '>' +
              '<label for="' + cid + '" class="shop-name"><span class="shop-title">' + U.esc(it.name) + '</span>' +
              (refs ? '<span class="shop-refs">для: ' + U.esc(refs) + '</span>' : '') + '</label>' +
              '<span class="shop-qty">' + qtyControls(it) + '</span>' +
              '<button type="button" class="icon-btn" data-del="' + U.esc(it.id) + '" aria-label="Удалить ' + U.esc(it.name) + '">✕</button></li>';
          }).join('') + '</ul></section>';
      }).join('');
      if (focusId) {
        var el = $('[data-id="' + focusId + '"] ' + (focusSel || '.shop-check'), box);
        if (el) el.focus();
      }
    }
    function openPdfDialog() {
      if (!DB.state.shopping.length) { UI.toast('Список пуст'); return; }
      var content = h('<div class="pdf-dialog"><p class="muted">Формат A5, крупный шрифт и квадратики для отметки — удобно читать с телефона или распечатать.</p>' +
        UI.switchHtml('pdf-only', 'Только некупленное', true) + '<p class="pdf-status muted small" aria-live="polite"></p></div>');
      var sw = $('#pdf-only', content);
      sw.addEventListener('click', function () { sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true')); });
      var foot = h('<div class="btn-row"><button type="button" class="btn btn-ghost" data-close>Отмена</button><button type="button" class="btn btn-primary" data-a="go">Скачать PDF</button></div>');
      var m = UI.modal({ title: 'Экспорт в PDF', content: content, footer: foot, size: 'sm' });
      var go = $('[data-a="go"]', foot);
      go.addEventListener('click', function () {
        go.disabled = true; go.textContent = 'Готовлю…';
        $('.pdf-status', content).textContent = 'Загружаю библиотеку и шрифт…';
        PDF.exportShopping(sw.getAttribute('aria-checked') === 'true').then(function (res) {
          m.close();
          UI.toast('Готово: ' + res.name + ' (' + res.pages + ' ' + U.plural(res.pages, 'страница', 'страницы', 'страниц') + ')');
        }).catch(function (err) {
          go.disabled = false; go.textContent = 'Скачать PDF';
          $('.pdf-status', content).textContent = '';
          UI.toast(err.message || String(err), { type: 'error' });
        });
      });
    }
    return { render: render, refresh: updateList };
  })();

  /* =======================================================================
   * UI: Холодильник — что есть дома и что из этого приготовить
   * ======================================================================= */
  var FridgeView = (function () {
    var root = null;
    var st = { meal: '', respect: true, limit: 12 };
    var FR_UNITS = ['г', 'кг', 'мл', 'л', 'шт'];

    function expiryHtml(item) {
      var d = Fridge.daysLeft(item.expires);
      if (d == null) return '';
      var txt = d < 0 ? 'просрочено' : d === 0 ? 'годен сегодня' : d === 1 ? 'до завтра' : 'до ' + U.formatDate(item.expires, { day: 'numeric', month: 'short' });
      return '<span class="fr-exp' + (d < 0 ? ' is-bad' : d <= 2 ? ' is-soon' : '') + '">' + U.esc(txt) + '</span>';
    }
    function restrictionsSwitch() {
      var rs = DB.state.settings.restrictions, dn = Diets.names(rs.diets), exN = rs.excluded.length;
      if (!dn.length && !exN) return '';
      var parts = [];
      if (dn.length) parts.push(dn.length === 1 ? 'диету «' + dn[0] + '»' : 'диеты: ' + dn.join(', '));
      if (exN) parts.push('исключённые продукты');
      return UI.switchHtml('fr-respect', 'Учитывать ' + parts.join(' и ') + ' из меню', st.respect);
    }

    function render() {
      root = h('<section class="view fridge-view" aria-labelledby="h-fridge">' +
        '<div class="view-head"><div><h1 id="h-fridge" tabindex="-1">Холодильник</h1><p class="muted" id="fr-count"></p></div>' +
        '<div class="btn-row wrap"><button type="button" class="btn btn-secondary" data-a="from-shop">Перенести купленное из списка покупок</button>' +
        '<button type="button" class="btn btn-ghost btn-danger-text" data-a="clear">Очистить холодильник</button></div></div>' +
        '<form class="card add-item fr-add" novalidate aria-label="Добавить продукт в холодильник">' +
        '<div class="field ai-name"><label for="fr-name">Продукт</label><input id="fr-name" type="text" placeholder="Например, яйца" maxlength="80"></div>' +
        '<div class="field ai-amount"><label for="fr-amount">Количество</label><input id="fr-amount" type="text" inputmode="decimal" placeholder="—" aria-describedby="fr-amount-hint"></div>' +
        '<div class="field ai-unit"><label for="fr-unit">Единица</label><select id="fr-unit">' + FR_UNITS.map(function (u) { return '<option>' + u + '</option>'; }).join('') + '</select></div>' +
        '<div class="field ai-cat"><label for="fr-exp">Годен до</label><input id="fr-exp" type="date"></div>' +
        '<button type="submit" class="btn btn-primary ai-submit">Добавить</button>' +
        '<p class="muted small fr-hint" id="fr-amount-hint">Количество и срок — по желанию. Без количества продукт просто считается «есть».</p></form>' +
        '<a class="btn btn-secondary btn-block fr-jump" href="#h-fr-match" hidden></a>' +
        '<div class="fridge-layout">' +
        '<div class="fr-col-items"><div id="fr-groups"></div>' +
        '<details class="card fr-pantry"><summary><span class="fr-pantry-title">Всегда есть дома</span> <span class="muted small" id="fr-pantry-sum"></span></summary>' +
        '<p class="muted small">Эти продукты не нужно добавлять в холодильник — при подборе рецептов они считаются имеющимися.</p>' +
        '<div id="fr-pantry-cats"></div>' +
        '<ul class="chip-list" id="fr-pantry-list" aria-label="Продукты, которые всегда есть дома"></ul>' +
        '<div class="field"><label for="fr-pantry-in">Добавить продукт</label><input id="fr-pantry-in" type="text" placeholder="Например, сахар" maxlength="80"></div></details></div>' +
        '<section class="card fr-col-match" aria-labelledby="h-fr-match"><h2 class="card-title" id="h-fr-match">Что приготовить</h2>' +
        '<p class="muted small">Сначала рецепты, для которых всё есть, затем те, где не хватает 1–' + Fridge.MAX_MISSING + ' продуктов.</p>' +
        '<div class="chips meal-chips" role="group" aria-label="Приём пищи">' +
        '<button type="button" class="chip" data-meal="">Все</button>' +
        Models.MEALS.map(function (m) { return '<button type="button" class="chip m-' + m.id + '" data-meal="' + m.id + '">' + m.emoji + ' ' + m.name + '</button>'; }).join('') + '</div>' +
        restrictionsSwitch() +
        '<p class="muted small" id="fr-match-count" aria-live="polite"></p><ul class="fr-matches" id="fr-matches"></ul></section>' +
        '</div></section>');

      /* ---------- добавление ---------- */
      var picked = null;
      var nameIn = $('#fr-name', root), amtIn = $('#fr-amount', root), unitSel = $('#fr-unit', root);
      UI.autocomplete(nameIn, {
        source: UI.productSource,
        onPick: function (it) {
          picked = it.product; nameIn.value = it.label; UI.fieldError(nameIn, null);
          var u = it.product.units || {};
          unitSel.value = u['шт'] ? 'шт' : (u['мл'] ? 'мл' : 'г');
          amtIn.focus();
        }
      });
      nameIn.addEventListener('input', function () { picked = null; });
      $('.fr-add', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var ok = true;
        var name = nameIn.value.trim();
        var prod = picked || DB.findProductByName(name);
        if (!name) ok = UI.fieldError(nameIn, 'Введите название') && ok;
        else if (!prod) ok = UI.fieldError(nameIn, 'Выберите продукт из подсказок. Нового нет в справочнике — добавьте его в «Настройках».') && ok;
        else UI.fieldError(nameIn, null);
        var amt = null;
        if (amtIn.value.trim() !== '') {
          amt = U.parseNum(amtIn.value);
          if (!(amt > 0)) ok = UI.fieldError(amtIn, 'Больше 0 или пусто') && ok; else UI.fieldError(amtIn, null);
        } else UI.fieldError(amtIn, null);
        if (!ok) { $('[aria-invalid="true"]', root).focus(); return; }
        var had = !!Fridge.byProduct(prod.id);
        Fridge.add({ productId: prod.id, amount: amt, unit: unitSel.value, expires: $('#fr-exp', root).value || null });
        if (!DB.save('fridge')) return;
        UI.toast(had ? '«' + prod.name + '» — количество обновлено' : '«' + prod.name + '» теперь в холодильнике');
        nameIn.value = ''; amtIn.value = ''; $('#fr-exp', root).value = ''; picked = null;
        nameIn.focus();
        update();
      });

      /* ---------- кнопки в шапке ---------- */
      $('[data-a="from-shop"]', root).addEventListener('click', function () {
        var bought = DB.state.shopping.filter(function (x) { return x.checked; }).length;
        if (!bought) { UI.toast('В списке покупок нет отмеченных купленных позиций'); return; }
        var snapF = Fridge.snapshot(), snapS = U.clone(DB.state.shopping);
        var res = Fridge.fromShopping();
        if (!res.moved) { UI.toast('Купленные позиции не найдены в справочнике продуктов: ' + res.skipped.join(', '), { type: 'error' }); return; }
        DB.save('fridge'); DB.save('shopping'); update();
        UI.toast('В холодильник: ' + res.moved + ' ' + U.plural(res.moved, 'продукт', 'продукта', 'продуктов') + (res.skipped.length ? '. Без продукта в справочнике остались в списке: ' + res.skipped.join(', ') : ''),
          { actionLabel: 'Отменить', onAction: function () { DB.state.shopping = snapS; DB.save('shopping'); Fridge.restore(snapF); update(); } });
      });
      $('[data-a="clear"]', root).addEventListener('click', function () {
        var n = Fridge.all().length;
        if (!n) { UI.toast('Холодильник уже пуст'); return; }
        UI.confirm({ title: 'Очистить холодильник?', text: 'Все ' + n + ' ' + U.plural(n, 'продукт будет удалён', 'продукта будут удалены', 'продуктов будут удалены') + ' из холодильника.', okText: 'Очистить', danger: true }).then(function (yes) {
          if (!yes) return;
          var snap = Fridge.snapshot();
          DB.state.fridge = []; DB.save('fridge'); update();
          UI.toast('Холодильник очищен', { actionLabel: 'Отменить', onAction: function () { Fridge.restore(snap); update(); } });
        });
      });

      /* ---------- список ---------- */
      $('#fr-groups', root).addEventListener('click', function (e) {
        var b = e.target.closest('[data-del]'); if (!b) return;
        var r = Fridge.remove(b.dataset.del); if (!r) return;
        var p = DB.product(r.item.productId);
        DB.save('fridge'); update();
        var next = $('#fr-groups [data-del]', root); if (next) next.focus(); else nameIn.focus();
        UI.toast('«' + (p ? p.name : 'Продукт') + '» убран из холодильника', { actionLabel: 'Отменить', onAction: function () {
          DB.state.fridge.splice(Math.min(r.index, DB.state.fridge.length), 0, r.item); DB.save('fridge'); update();
        } });
      });

      /* ---------- «всегда есть дома» ---------- */
      var pIn = $('#fr-pantry-in', root);
      UI.autocomplete(pIn, {
        source: function (q) { return UI.productSource(q).filter(function (it) { return DB.state.settings.pantry.products.indexOf(it.id) < 0; }); },
        onPick: function (it) {
          DB.state.settings.pantry.products.push(it.id); pIn.value = '';
          DB.save('settings'); renderPantry(); updateMatches();
          UI.toast('«' + it.label + '» — всегда есть дома');
        }
      });
      $('#fr-pantry-list', root).addEventListener('click', function (e) {
        var b = e.target.closest('[data-pt]'); if (!b) return;
        var arr = DB.state.settings.pantry.products; arr.splice(arr.indexOf(b.dataset.pt), 1);
        DB.save('settings'); renderPantry(); updateMatches(); pIn.focus();
      });
      $('#fr-pantry-cats', root).addEventListener('click', function (e) {
        var b = e.target.closest('[data-ptcat]'); if (!b) return;
        var arr = DB.state.settings.pantry.categories, i = arr.indexOf(b.dataset.ptcat);
        if (i >= 0) arr.splice(i, 1); else arr.push(b.dataset.ptcat);
        b.setAttribute('aria-checked', String(i < 0));
        DB.save('settings'); renderPantry(true); updateMatches();
      });

      /* ---------- подбор рецептов ---------- */
      $$('.fr-col-match .meal-chips .chip', root).forEach(function (c) {
        c.addEventListener('click', function () { st.meal = c.dataset.meal; st.limit = 12; updateMatches(); });
      });
      var sw = $('#fr-respect', root);
      if (sw) sw.addEventListener('click', function () { st.respect = !st.respect; sw.setAttribute('aria-checked', String(st.respect)); st.limit = 12; updateMatches(); });
      $('#fr-matches', root).addEventListener('click', function (e) {
        var b = e.target.closest('[data-r]'); if (!b) return;
        var r = DB.recipe(b.closest('[data-rid]').dataset.rid); if (!r) return;
        if (b.dataset.r === 'open') RecipesView.openRecipe(r.id);
        if (b.dataset.r === 'buy') {
          var n = Fridge.buyMissing(r);
          if (DB.save('shopping')) UI.toast('В список покупок: ' + n + ' ' + U.plural(n, 'продукт', 'продукта', 'продуктов') + ' для «' + r.title + '»', { actionLabel: 'Открыть список', onAction: function () { location.hash = '#shopping'; } });
        }
      });
      $('.fr-jump', root).addEventListener('click', function (e) {
        e.preventDefault(); var t = $('#h-fr-match', root);
        t.scrollIntoView({ behavior: global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: true });
      });
      $('.fr-col-match', root).addEventListener('click', function (e) {
        if (e.target.closest('[data-more]')) { st.limit += 12; updateMatches(); }
      });
      update();
      return root;
    }

    function renderPantry(keepFocus) {
      var pt = DB.state.settings.pantry;
      var cats = DB.state.settings.categories.filter(function (c) { return c.id === 'spices' || pt.categories.indexOf(c.id) >= 0; });
      $('#fr-pantry-cats', root).innerHTML = cats.map(function (c) {
        return UI.switchHtml('fr-ptc-' + c.id, 'Вся категория «' + c.name + '»', pt.categories.indexOf(c.id) >= 0, ' data-ptcat="' + U.esc(c.id) + '"');
      }).join('');
      if (keepFocus) { var f = $('[data-ptcat]', root); if (f && document.activeElement === document.body) f.focus(); }
      $('#fr-pantry-list', root).innerHTML = pt.products.length ? pt.products.map(function (id) {
        var p = DB.product(id);
        return '<li class="chip chip-removable"><span>' + U.esc(p ? p.name : id) + '</span><button type="button" class="chip-x" data-pt="' + U.esc(id) + '" aria-label="Убрать «' + U.esc(p ? p.name : id) + '» из списка «всегда есть дома»">✕</button></li>';
      }).join('') : '<li class="muted small">Список пуст</li>';
      var n = pt.products.length, c = pt.categories.length;
      $('#fr-pantry-sum', root).textContent = '· ' + n + ' ' + U.plural(n, 'продукт', 'продукта', 'продуктов') + (c ? ' и ' + c + ' ' + U.plural(c, 'категория', 'категории', 'категорий') : '');
    }

    function update() {
      if (!root) return;
      var list = Fridge.all();
      $('#fr-count', root).textContent = list.length ? list.length + ' ' + U.plural(list.length, 'продукт', 'продукта', 'продуктов') + ' дома' : '';
      $('[data-a="clear"]', root).disabled = !list.length;
      var box = $('#fr-groups', root);
      box.innerHTML = '';
      root.classList.toggle('is-empty', !list.length);
      if (!list.length) {
        var bought = DB.state.shopping.filter(function (x) { return x.checked; }).length;
        box.appendChild(UI.emptyState({ emoji: '🧊', title: 'Холодильник пуст',
          text: 'Добавьте продукты, которые есть дома, — Foodly! подберёт рецепты, для которых меньше всего нужно докупать.' + (bought ? ' Или перенесите купленное из списка покупок.' : ''),
          actionLabel: 'Добавить продукт', onAction: function () { $('#fr-name', root).focus(); } }));
      } else {
        box.innerHTML = Fridge.grouped().map(function (g) {
          var gid = 'frg-' + g.id;
          return '<section class="shop-group card" aria-labelledby="' + gid + '"><h2 class="shop-group-title" id="' + gid + '">' + U.esc(g.name) +
            ' <span class="count">' + g.items.length + '</span></h2><ul class="shop-items fr-items">' +
            g.items.map(function (x) {
              var it = x.item;
              return '<li class="fr-item"><span class="fr-name">' + U.esc(x.name) + '</span>' +
                '<span class="fr-meta"><span class="fr-qty' + (it.amount == null ? ' is-any' : '') + '">' + U.esc(Fridge.qtyLabel(it)) + '</span>' + expiryHtml(it) + '</span>' +
                '<button type="button" class="icon-btn" data-del="' + U.esc(it.id) + '" aria-label="Убрать ' + U.esc(x.name) + ' из холодильника">✕</button></li>';
            }).join('') + '</ul></section>';
        }).join('');
      }
      renderPantry();
      updateMatches();
    }

    function updateMatches() {
      if (!root) return;
      $$('.fr-col-match .meal-chips .chip', root).forEach(function (c) { c.setAttribute('aria-pressed', String(c.dataset.meal === st.meal)); });
      var ul = $('#fr-matches', root), cnt = $('#fr-match-count', root);
      var more = $('.fr-col-match [data-more]', root); if (more) more.remove();
      ul.innerHTML = '';
      $('.fr-jump', root).hidden = true;
      if (!Fridge.all().length) { cnt.textContent = 'Добавьте продукты — здесь появятся рецепты.'; return; }
      var res = Fridge.suggestions({ meal: st.meal, respect: st.respect });
      var full = res.filter(function (x) { return !x.match.missing.length; }).length;
      if (!res.length) {
        cnt.textContent = '';
        ul.innerHTML = '<li class="fr-none"><span class="fr-none-emoji" aria-hidden="true">🤔</span><span><strong>Подходящих рецептов нет.</strong> ' +
          'Нет рецептов' + (st.meal ? ' для этого приёма пищи' : '') + ', где используются ваши продукты и не хватает не больше ' + Fridge.MAX_MISSING + ' других. Добавьте ещё продукты' +
          (st.meal ? ', выберите «Все»' : '') + (st.respect && $('#fr-respect', root) ? ' или выключите учёт ограничений из меню' : '') + '.</span></li>';
        return;
      }
      var jump = $('.fr-jump', root);
      jump.hidden = false; jump.textContent = 'Что приготовить: ' + res.length + ' ' + U.plural(res.length, 'рецепт', 'рецепта', 'рецептов') + (full ? ' (всё есть — ' + full + ')' : '') + ' ↓';
      cnt.textContent = 'Найдено ' + res.length + ' ' + U.plural(res.length, 'рецепт', 'рецепта', 'рецептов') + (full ? ', из них ' + full + ' — всё есть' : '');
      ul.innerHTML = res.slice(0, st.limit).map(function (x) {
        var r = x.recipe, m = x.match;
        var ps = Nutrition.perServing(r);
        var miss = m.missing.map(function (y) {
          return '<span class="fr-miss">' + U.esc(y.name) + (y.partial ? ' <span class="muted">(мало: есть ' + U.esc(Shopping.formatQty(y.haveAmount, y.unit)) + ' из ' + U.esc(Shopping.formatQty(y.amount, y.unit)) + ')</span>' : '') + '</span>';
        }).join(', ');
        return '<li class="fr-match' + (m.missing.length ? '' : ' is-full') + '" data-rid="' + U.esc(r.id) + '">' +
          UI.mediaHtml(r, 'fr-media') +
          '<div class="fr-match-body"><h3 class="fr-match-title">' + U.esc(r.title) + '</h3>' +
          '<p class="muted small">' + U.fmt(ps.kcal) + ' ккал на порцию · из холодильника ' + m.have.length + ' из ' + m.total + '</p>' +
          (m.missing.length ? '<p class="fr-status fr-status-miss"><strong>Не хватает:</strong> ' + miss + '</p>' : '<p class="fr-status fr-status-ok">Есть всё 🎉</p>') +
          '<div class="btn-row"><button type="button" class="btn btn-secondary btn-sm" data-r="open">Открыть рецепт</button>' +
          (m.missing.length ? '<button type="button" class="btn btn-primary btn-sm" data-r="buy">Докупить недостающее</button>' : '') + '</div></div></li>';
      }).join('');
      if (res.length > st.limit) ul.insertAdjacentElement('afterend', h('<button type="button" class="btn btn-secondary btn-block" data-more>Показать ещё (' + (res.length - st.limit) + ')</button>'));
    }
    return { render: render, refresh: update };
  })();

  /* =======================================================================
   * UI: Меню на неделю (план питания)
   * ======================================================================= */
  var PlanView = (function () {
    var root = null;
    var setupOpen = null;          // панель параметров раскрыта?
    var openDays = {};             // раскрытые дни: date → true
    var openPlanId = null;
    function S() { return DB.state.settings; }
    function ensureTargets() {
      if (!S().targets || !S().targetsManual) S().targets = Nutrition.targetsFor(S());
    }
    function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
    function peopleWord(n) { return U.plural(n, 'человека', 'человек', 'человек'); }
    function numField(id, label, val, suffix, hint) {
      return '<div class="field"><label for="' + id + '">' + label + (suffix ? ' <span class="muted">' + suffix + '</span>' : '') + '</label>' +
        '<input id="' + id + '" type="text" inputmode="decimal" value="' + U.esc(val) + '"' + (hint ? ' aria-describedby="' + id + '-hint"' : '') + '>' +
        (hint ? '<p class="field-hint small muted" id="' + id + '-hint">' + hint + '</p>' : '') + '</div>';
    }

    function render() {
      ensureTargets();
      var s = S(), p = s.profile, t = s.targets;
      if (setupOpen === null) setupOpen = !DB.state.plan;
      root = h('<section class="view" aria-labelledby="h-plan">' +
        '<div class="view-head"><div><h1 id="h-plan" tabindex="-1">Меню на неделю</h1>' +
        '<p class="muted lead">Блюда на 7 дней под вашу дневную норму калорий. Нажмите на день, чтобы увидеть, что в нём.</p></div></div>' +
        '<div class="plan-summary card"><div class="ps-text" id="plan-summary"></div>' +
        '<div class="btn-row wrap ps-actions"><button type="button" class="btn btn-ghost" data-a="toggle-setup" aria-controls="plan-setup">Изменить параметры</button>' +
        '<button type="button" class="btn btn-primary" data-a="generate"></button></div></div>' +
        '<div class="plan-setup" id="plan-setup">' +
        '<form class="card setup-card" id="profile-form" novalidate><h2 class="card-title">Ваши данные для расчёта нормы</h2>' +
        '<fieldset class="field"><legend>Пол</legend><div class="seg">' +
        '<label><input type="radio" name="sex" value="female"' + (p.sex !== 'male' ? ' checked' : '') + '><span>Женский</span></label>' +
        '<label><input type="radio" name="sex" value="male"' + (p.sex === 'male' ? ' checked' : '') + '><span>Мужской</span></label></div></fieldset>' +
        '<div class="form-grid g3">' + numField('pf-age', 'Возраст', p.age, 'лет') + numField('pf-height', 'Рост', p.height, 'см') + numField('pf-weight', 'Вес', p.weight, 'кг') + '</div>' +
        '<div class="form-grid g2"><div class="field"><label for="pf-activity">Физическая активность</label><select id="pf-activity">' +
        Nutrition.ACTIVITY.map(function (a) { return '<option value="' + a.v + '"' + (Number(p.activity) === a.v ? ' selected' : '') + '>' + a.label + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label for="pf-goal">Цель</label><select id="pf-goal">' +
        [['lose', 'Похудеть (−15% калорий)'], ['maintain', 'Сохранить вес'], ['gain', 'Набрать вес (+10% калорий)']].map(function (g) { return '<option value="' + g[0] + '"' + (p.goal === g[0] ? ' selected' : '') + '>' + g[1] + '</option>'; }).join('') + '</select></div></div>' +
        '<h3 class="sub-title">Дневная норма на 1 человека</h3><p class="muted small" id="targets-hint"></p>' +
        '<div class="form-grid g4 targets">' + numField('tg-kcal', 'Калории', t.kcal, 'ккал') + numField('tg-protein', 'Белки', t.protein, 'г') + numField('tg-fat', 'Жиры', t.fat, 'г') + numField('tg-carbs', 'Углеводы', t.carbs, 'г') + '</div>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-a="recalc">Вернуть расчётные значения</button>' +
        '</form>' +
        '<div class="card setup-card"><h2 class="card-title">Параметры меню</h2>' +
        '<div class="form-grid g2"><div class="field"><label for="pp-meals">Приёмов пищи в день</label><select id="pp-meals">' +
        [[3, '3 — завтрак, обед, ужин'], [4, '4 — плюс перекус'], [5, '5 — плюс два перекуса']].map(function (o) { return '<option value="' + o[0] + '"' + (s.mealsPerDay === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label for="pp-start">Первый день меню</label><input id="pp-start" type="date" value="' + U.esc(s.planStart || U.todayISO()) + '"></div></div>' +
        numField('pp-people', 'Сколько человек будут есть', s.people, '', 'Калории считаются на одного человека, а продукты в списке покупок — на всех.') +
        '<fieldset class="field field-diets"><legend>Диета</legend>' +
        '<p class="field-hint small muted" id="pp-diets-hint">В меню попадут только блюда, подходящие под все выбранные диеты.</p>' +
        '<div class="chips diet-chips" id="pp-diets" aria-describedby="pp-diets-hint">' +
        Diets.all().map(function (d) { return '<button type="button" class="chip" data-diet="' + U.esc(d.id) + '" aria-pressed="' + (s.restrictions.diets.indexOf(d.id) >= 0) + '">' + U.esc(Diets.label(d)) + '</button>'; }).join('') +
        '</div><p class="small muted diet-count" id="pp-diets-count" aria-live="polite"></p></fieldset>' +
        '<div class="field"><label for="ex-input">Не использовать продукты</label><input id="ex-input" type="text" placeholder="Например, яйцо — блюда с ним не попадут в меню"></div>' +
        '<ul class="chip-list" id="ex-list" aria-label="Продукты, которые не используем"></ul>' +
        '<div class="switch-col">' + UI.switchHtml('sw-protein', 'Чаще предлагать блюда с высоким содержанием белка', s.restrictions.moreProtein) +
        UI.switchHtml('sw-fiber', 'Чаще предлагать блюда, богатые клетчаткой', s.restrictions.moreFiber) + '</div>' +
        '</div></div><div id="plan-box"></div></section>');

      updateTargetsHint();
      updateSummary();
      syncSetup();
      $('[data-a="toggle-setup"]', root).addEventListener('click', function () { setupOpen = !setupOpen; syncSetup(true); });
      function readProfile() {
        var sex = $('input[name="sex"]:checked', root).value;
        var np = { sex: sex, age: U.parseNum($('#pf-age', root).value), height: U.parseNum($('#pf-height', root).value), weight: U.parseNum($('#pf-weight', root).value),
          activity: Number($('#pf-activity', root).value), goal: $('#pf-goal', root).value };
        var ok = true;
        [['#pf-age', np.age, 14, 100, 'Укажите возраст от 14 до 100 лет'], ['#pf-height', np.height, 120, 230, 'Укажите рост от 120 до 230 см'], ['#pf-weight', np.weight, 35, 250, 'Укажите вес от 35 до 250 кг']].forEach(function (x) {
          var el = $(x[0], root);
          if (isNaN(x[1]) || x[1] < x[2] || x[1] > x[3]) ok = UI.fieldError(el, x[4]) && ok; else UI.fieldError(el, null);
        });
        if (!ok) return;
        S().profile = np;
        if (!S().targetsManual) { S().targets = Nutrition.targetsFor(S()); fillTargets(); }
        DB.save('settings'); changed();
      }
      $$('#profile-form input[name="sex"], #pf-activity, #pf-goal', root).forEach(function (el) { el.addEventListener('change', readProfile); });
      ['#pf-age', '#pf-height', '#pf-weight'].forEach(function (sel) { $(sel, root).addEventListener('change', readProfile); });
      function fillTargets() {
        var tt = S().targets;
        $('#tg-kcal', root).value = tt.kcal; $('#tg-protein', root).value = tt.protein; $('#tg-fat', root).value = tt.fat; $('#tg-carbs', root).value = tt.carbs;
        $$('.targets input', root).forEach(function (i) { UI.fieldError(i, null); });
      }
      $$('.targets input', root).forEach(function (inp) {
        inp.addEventListener('change', function () {
          var v = U.parseNum(inp.value);
          var isK = inp.id === 'tg-kcal';
          if (isNaN(v) || v < (isK ? 800 : 0) || v > (isK ? 6000 : 800)) { UI.fieldError(inp, isK ? 'От 800 до 6000 ккал' : 'От 0 до 800 г'); return; }
          UI.fieldError(inp, null);
          S().targets[inp.id.slice(3)] = Math.round(v);
          S().targetsManual = true;
          DB.save('settings'); changed(); updateDietCount();
        });
      });
      $('[data-a="recalc"]', root).addEventListener('click', function () {
        S().targetsManual = false; S().targets = Nutrition.targetsFor(S());
        DB.save('settings'); fillTargets(); changed(); updateDietCount();
        UI.toast('Норма рассчитана заново: ' + S().targets.kcal + ' ккал в день');
      });
      var exIn = $('#ex-input', root);
      UI.autocomplete(exIn, {
        source: function (q) { return UI.productSource(q).filter(function (it) { return S().restrictions.excluded.indexOf(it.id) < 0; }); },
        onPick: function (it) {
          S().restrictions.excluded.push(it.id); exIn.value = '';
          DB.save('settings'); renderExcluded(); changed();
          var n = Recipes.ready().filter(function (r) { return Recipes.containsProduct(r, [it.id]); }).length;
          UI.toast('«' + it.label + '» не используем' + (n ? ': ' + n + ' ' + U.plural(n, 'рецепт не попадёт', 'рецепта не попадут', 'рецептов не попадут') + ' в меню' : ''));
        }
      });
      function renderExcluded() {
        var ul = $('#ex-list', root);
        var ex = S().restrictions.excluded;
        ul.innerHTML = ex.length ? ex.map(function (id) {
          var pr = DB.product(id);
          return '<li class="chip chip-removable"><span>' + U.esc(pr ? pr.name : id) + '</span><button type="button" class="chip-x" data-ex="' + U.esc(id) + '" aria-label="Снова использовать ' + U.esc(pr ? pr.name : id) + '">✕</button></li>';
        }).join('') : '<li class="muted small">Все продукты разрешены</li>';
        updateDietCount();
      }
      $('#ex-list', root).addEventListener('click', function (e) {
        var b = e.target.closest('[data-ex]'); if (!b) return;
        var ex = S().restrictions.excluded; ex.splice(ex.indexOf(b.dataset.ex), 1);
        DB.save('settings'); renderExcluded(); changed(); exIn.focus();
      });
      renderExcluded();
      function updateDietCount() {
        var el = $('#pp-diets-count', root), ids = S().restrictions.diets;
        if (!ids.length) { el.textContent = ''; return; }
        var ex = S().restrictions.excluded;
        var n = Recipes.ready().filter(function (r) { return Diets.fitsAll(r, ids) && !Recipes.containsProduct(r, ex); }).length;
        var txt = n ? 'Подходящих рецептов: ' + n + '.' + (n < 8 ? ' Этого мало для разнообразного меню — блюда будут повторяться.' : '') : 'Нет рецептов, подходящих под все выбранные диеты.';
        // кето выбрано, а норма задана вручную и не кетогенная — подскажем
        if (Nutrition.macroMode(S()) === 'keto' && S().targetsManual && S().targets.carbs > 50) txt += ' Норма задана вручную и не подходит для кето (углеводов больше 50 г) — нажмите «Вернуть расчётные значения».';
        el.textContent = txt;
      }
      $('#pp-diets', root).addEventListener('click', function (e) {
        var c = e.target.closest('[data-diet]'); if (!c) return;
        var ids = S().restrictions.diets, i = ids.indexOf(c.dataset.diet);
        var wasKeto = Nutrition.macroMode(S()) === 'keto';
        if (i >= 0) ids.splice(i, 1); else ids.push(c.dataset.diet);
        c.setAttribute('aria-pressed', String(i < 0));
        var isKeto = Nutrition.macroMode(S()) === 'keto';
        if (!S().targetsManual) { S().targets = Nutrition.targetsFor(S()); fillTargets(); }
        DB.save('settings'); updateDietCount(); changed();
        if (wasKeto !== isKeto && !S().targetsManual) UI.toast(isKeto ? 'Норма пересчитана для кето: ' + S().targets.fat + ' г жиров, ' + S().targets.protein + ' г белков, ' + S().targets.carbs + ' г углеводов' : 'Норма пересчитана для обычного питания');
      });
      updateDietCount();
      [['#sw-protein', 'moreProtein'], ['#sw-fiber', 'moreFiber']].forEach(function (x) {
        var sw = $(x[0], root);
        sw.addEventListener('click', function () {
          var v = sw.getAttribute('aria-checked') !== 'true';
          sw.setAttribute('aria-checked', String(v));
          S().restrictions[x[1]] = v; DB.save('settings'); changed();
        });
      });
      $('#pp-meals', root).addEventListener('change', function (e) { S().mealsPerDay = Number(e.target.value); DB.save('settings'); changed(); updateDietCount(); });
      $('#pp-people', root).addEventListener('change', function (e) {
        var v = parseInt(e.target.value, 10);
        if (!(v >= 1 && v <= 20)) { UI.fieldError(e.target, 'От 1 до 20 человек'); return; }
        UI.fieldError(e.target, null); S().people = v; DB.save('settings');
        if (DB.state.plan) { DB.state.plan.settings.people = v; DB.save('plan'); }
        updateSummary();
      });
      $('#pp-start', root).addEventListener('change', function (e) { S().planStart = e.target.value; DB.save('settings'); });
      $('[data-a="generate"]', root).addEventListener('click', function () { generate(); });
      renderPlan();
      return root;
    }
    function changed() { updateTargetsHint(); updateSummary(); updatePlanNotice(); }
    function syncSetup(focus) {
      var panel = $('#plan-setup', root), btn = $('[data-a="toggle-setup"]', root);
      panel.hidden = !setupOpen;
      btn.setAttribute('aria-expanded', String(setupOpen));
      btn.textContent = setupOpen ? 'Скрыть параметры' : 'Изменить параметры';
      if (focus && setupOpen) { var f = $('input, select', panel); if (f) f.focus(); }
    }
    function updateTargetsHint() {
      var el = root && $('#targets-hint', root);
      if (!el) return;
      var keto = Nutrition.macroMode(S()) === 'keto';
      if (S().targetsManual) el.textContent = 'Задана вручную.' + (keto ? ' Чтобы получить кето-норму, нажмите «Вернуть расчётные значения».' : '');
      else if (keto) el.textContent = 'Кето-норма. Калории — по формуле Миффлина–Сан Жеора с учётом активности и цели. Углеводы — 5% калорий, но 20–30 г в день. Белок — 1,4 г на кг веса (1,6 при похудении, 1,7 при наборе), не больше 25% калорий. Остальное — жиры, около 70–75% калорий. Любое значение можно поправить.';
      else el.textContent = 'Рассчитана по формуле Миффлина–Сан Жеора с учётом активности и цели. Любое значение можно поправить.';
    }
    function updateSummary() {
      var el = root && $('#plan-summary', root); if (!el) return;
      var s = S(), t = s.targets, ex = s.restrictions.excluded;
      var exNames = ex.map(function (id) { var p = DB.product(id); return p ? p.name.toLowerCase() : id; });
      el.innerHTML = '<p class="ps-main"><strong>' + U.fmt(t.kcal) + ' ккал в день</strong> на одного человека</p>' +
        '<p class="muted">Белки ' + t.protein + ' г, жиры ' + t.fat + ' г, углеводы ' + t.carbs + ' г' + (function () {
          if (Nutrition.macroMode(s) !== 'keto') return '';
          var pc = Nutrition.macroPct(t);
          return ' · ' + U.fmt(pc.fat) + '% калорий из жиров, ' + U.fmt(pc.protein) + '% из белков, ' + U.fmt(pc.carbs) + '% из углеводов';
        })() + '</p>' +
        '<ul class="facts"><li>' + s.mealsPerDay + ' ' + U.plural(s.mealsPerDay, 'приём', 'приёма', 'приёмов') + ' пищи в день</li>' +
        '<li>Продукты на ' + s.people + ' ' + peopleWord(s.people) + '</li>' +
        (Diets.names(s.restrictions.diets).length ? '<li>Диета: ' + U.esc(Diets.names(s.restrictions.diets).join(', ')) + '</li>' : '') +
        (exNames.length ? '<li>Без: ' + U.esc(exNames.slice(0, 3).join(', ')) + (exNames.length > 3 ? ' и ещё ' + (exNames.length - 3) : '') + '</li>' : '') + '</ul>';
      $('[data-a="generate"]', root).textContent = DB.state.plan ? 'Составить новое меню' : 'Составить меню на неделю';
    }
    function cfgChanged() {
      var plan = DB.state.plan; if (!plan) return false;
      var a = plan.settings, s = S();
      return JSON.stringify([a.targets, a.mealsPerDay, a.restrictions]) !== JSON.stringify([s.targets, s.mealsPerDay, s.restrictions]);
    }
    function updatePlanNotice() {
      var n = root && $('#plan-notice', root);
      if (n) n.hidden = !cfgChanged();
    }
    function generate() {
      if (!Recipes.ready().length) { UI.toast('Сначала добавьте рецепты', { type: 'error' }); return; }
      var start = ($('#pp-start', root) && $('#pp-start', root).value) || U.todayISO();
      var had = !!DB.state.plan;
      var plan = Planner.generate(S(), start);
      DB.state.plan = plan;
      DB.save('plan');
      setupOpen = false; syncSetup();
      renderPlan();
      updateSummary();
      var warn = plan.days.filter(function (d) { return d.warning; }).length;
      UI.toast(warn ? 'Меню готово, но в ' + warn + ' ' + U.plural(warn, 'дне', 'днях', 'днях') + ' есть замечания' : (had ? 'Составлено новое меню' : 'Меню на неделю готово'));
      var box = $('#plan-box', root); if (box) box.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }
    function saveStateHtml(plan) {
      return plan.savedAt
        ? '<p class="save-state small is-saved">✓ Сохранено ' + new Date(plan.savedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '</p>'
        : '<p class="save-state small is-draft">Изменения не сохранены</p>';
    }
    function renderPlan(focusSel) {
      var box = $('#plan-box', root);
      var plan = DB.state.plan;
      box.innerHTML = '';
      if (!plan) {
        box.appendChild(UI.emptyState({ emoji: '🗓️', title: 'Меню пока нет', text: 'Проверьте параметры выше и нажмите «Составить меню на неделю» — блюда подберутся под вашу норму.',
          actionLabel: 'Составить меню на неделю', onAction: generate }));
        return;
      }
      if (openPlanId !== plan.id) {
        openPlanId = plan.id; openDays = {};
        var today = U.todayISO();
        var first = plan.days.filter(function (d) { return d.date === today; })[0] || plan.days[0];
        openDays[first.date] = true;
      }
      var head = h('<div class="plan-head"><div><h2>Меню с ' + U.esc(U.formatDate(plan.days[0].date, { day: 'numeric', month: 'long' })) + ' по ' +
        U.esc(U.formatDate(plan.days[plan.days.length - 1].date, { day: 'numeric', month: 'long' })) + '</h2>' + saveStateHtml(plan) + '</div>' +
        '<div class="btn-row wrap"><button type="button" class="btn btn-ghost" data-a="save">Сохранить меню</button>' +
        '<button type="button" class="btn btn-primary" data-a="shop">Добавить продукты в список покупок</button></div></div>');
      box.appendChild(head);
      box.appendChild(h('<p class="notice" id="plan-notice" hidden>Параметры изменились после того, как меню было составлено. Нажмите «Составить новое меню», чтобы их учесть.</p>'));
      updatePlanNotice();
      $('[data-a="save"]', head).addEventListener('click', function () {
        plan.savedAt = Date.now();
        if (DB.save('plan')) { UI.toast('Меню сохранено'); renderPlan('[data-a="save"]'); }
      });
      $('[data-a="shop"]', head).addEventListener('click', buildShopping);
      var allOpen = plan.days.every(function (d) { return openDays[d.date]; });
      var tools = h('<div class="days-tools"><button type="button" class="link-btn small" data-a="all"></button></div>');
      $('[data-a="all"]', tools).textContent = allOpen ? 'Свернуть все дни' : 'Развернуть все дни';
      $('[data-a="all"]', tools).addEventListener('click', function () {
        var open = !plan.days.every(function (d) { return openDays[d.date]; });
        plan.days.forEach(function (d) { openDays[d.date] = open; });
        renderPlan('[data-a="all"]');
      });
      box.appendChild(tools);
      var list = h('<ol class="days"></ol>');
      plan.days.forEach(function (d, di) { list.appendChild(dayItem(plan, d, di)); });
      box.appendChild(list);
      if (focusSel) { var el = $(focusSel, box); if (el) el.focus(); }
    }
    function thumb(r) {
      return '<span class="day-thumb">' + (r ? UI.mediaHtml(r, 'thumb-media') : '<span class="ph">·</span>') + '</span>';
    }
    function dayItem(plan, d, di) {
      var ev = Planner.evaluateDay(plan, di);
      var tt = ev.totals, t = plan.settings.targets;
      var pct = Math.round(ev.dev * 100);
      var lvlText = { ok: 'в пределах нормы', warn: 'заметно отличается от нормы', bad: 'сильно отличается от нормы' }[ev.level];
      var open = !!openDays[d.date];
      var bodyId = 'day-body-' + di;
      var dateObj = d.date.split('-');
      var recipes = d.meals.map(function (m) { return m.recipeId ? DB.recipe(m.recipeId) : null; });
      var li = h('<li class="day lvl-' + ev.level + (open ? ' is-open' : '') + '" data-date="' + d.date + '">' +
        '<h3 class="day-h"><button type="button" class="day-toggle" aria-expanded="' + open + '" aria-controls="' + bodyId + '">' +
        '<span class="day-date"><span class="dd-wd">' + U.esc(cap(U.formatDate(d.date, { weekday: 'long' }))) + '</span>' +
        '<span class="dd-d">' + U.esc(U.formatDate(d.date, { day: 'numeric', month: 'long' })) + '</span></span>' +
        '<span class="day-thumbs" aria-hidden="true">' + recipes.map(thumb).join('') + '</span>' +
        '<span class="day-kcal"><strong>' + U.fmt(tt.kcal) + '</strong> из ' + U.fmt(t.kcal) + ' ккал</span>' +
        '<span class="dev-pill dev-' + ev.level + '">' + (pct > 0 ? '+' : pct < 0 ? '−' : '') + Math.abs(pct) + '%<span class="sr-only"> — ' + lvlText + '</span></span>' +
        (d.warning ? '<span class="day-flag" title="Есть замечание">⚠<span class="sr-only">Есть замечание</span></span>' : '') +
        '<span class="chev" aria-hidden="true"></span></button></h3>' +
        '<div class="day-body" id="' + bodyId + '"' + (open ? '' : ' hidden') + '>' +
        (d.warning ? '<p class="day-warn" role="note">⚠ ' + U.esc(d.warning) + '</p>' : '') +
        '<ul class="meals"></ul>' +
        '<div class="day-foot"><p class="muted small">За день: белки ' + U.fmt(tt.protein) + ' г из ' + t.protein + ', жиры ' + U.fmt(tt.fat) + ' г из ' + t.fat + ', углеводы ' + U.fmt(tt.carbs) + ' г из ' + t.carbs + ', клетчатка ' + U.fmt(tt.fiber) + ' г</p>' +
        (plan.settings.macroMode === 'keto' ? (function () { var pc = Nutrition.macroPct(tt); return '<p class="small keto-day' + (pc.fat >= 65 && tt.carbs <= t.carbs * 1.1 ? '' : ' is-off') + '">Кето: ' + U.fmt(pc.fat) + '% калорий из жиров, ' + U.fmt(pc.protein) + '% из белков, ' + U.fmt(pc.carbs) + '% из углеводов</p>'; })() : '') +
        '<button type="button" class="btn btn-ghost btn-sm" data-a="regen">Подобрать блюда на этот день заново</button></div></div></li>');
      $('.day-toggle', li).addEventListener('click', function () {
        openDays[d.date] = !openDays[d.date];
        var b = $('.day-toggle', li);
        b.setAttribute('aria-expanded', String(!!openDays[d.date]));
        $('.day-body', li).hidden = !openDays[d.date];
        li.classList.toggle('is-open', !!openDays[d.date]);
        var tools = $('[data-a="all"]', root);
        if (tools) tools.textContent = DB.state.plan.days.every(function (x) { return openDays[x.date]; }) ? 'Свернуть все дни' : 'Развернуть все дни';
      });
      var ul = $('.meals', li);
      d.meals.forEach(function (m, mi) {
        var r = recipes[mi];
        var n = r ? Planner.mealNutrition(plan, m) : null;
        var row = h('<li class="meal m-' + m.slot + '">' +
          '<div class="meal-photo">' + (r ? UI.mediaHtml(r, 'meal-media') : '<div class="meal-media"><div class="ph"><span>🍽️</span></div></div>') + '</div>' +
          '<div class="meal-info"><span class="meal-slot">' + U.esc(Models.mealName(m.slot)) + '</span>' +
          (r ? '<button type="button" class="meal-title link-btn" data-a="open">' + U.esc(r.title) + '</button>' : '<span class="meal-title muted">Нет подходящего блюда</span>') +
          '<span class="meal-sub">' + (n ? U.fmt(m.portions, 1) + ' ' + U.plural(Math.ceil(m.portions), 'порция', 'порции', 'порций') + ', ' + U.fmt(n.kcal) + ' ккал' : '') + '</span></div>' +
          '<div class="meal-ctrls"><div class="stepper stepper-sm" role="group" aria-label="Порции: ' + U.esc(r ? r.title : '') + '"><button type="button" class="icon-btn" data-a="minus" aria-label="Меньше порций"' + (m.portions <= 0.5 ? ' disabled' : '') + '>−</button>' +
          '<span class="stepper-val">' + U.fmt(m.portions, 1) + '</span>' +
          '<button type="button" class="icon-btn" data-a="plus" aria-label="Больше порций"' + (m.portions >= 2.5 ? ' disabled' : '') + '>+</button></div>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-a="replace">Заменить блюдо</button></div></li>');
        row.addEventListener('click', function (e) {
          var b = e.target.closest('[data-a]'); if (!b) return;
          var a = b.dataset.a;
          if (a === 'open' && r) RecipesView.openRecipe(r.id);
          if (a === 'minus' || a === 'plus') {
            m.portions = U.round(Math.max(0.5, Math.min(2.5, m.portions + (a === 'plus' ? 0.5 : -0.5))), 1);
            d.warning = null; plan.savedAt = null; DB.save('plan');
            replaceDay(plan, di, '.meals > li:nth-child(' + (mi + 1) + ') [data-a="' + a + '"]');
          }
          if (a === 'replace') openReplace(plan, di, mi);
        });
        ul.appendChild(row);
      });
      $('[data-a="regen"]', li).addEventListener('click', function () {
        Planner.regenerateDay(plan, di);
        DB.save('plan');
        replaceDay(plan, di, '[data-a="regen"]');
        UI.toast(cap(U.formatDate(d.date)) + ': блюда подобраны заново');
      });
      return li;
    }
    function refreshHead() {
      var st = $('.save-state', root);
      var plan = DB.state.plan;
      if (st && plan) st.outerHTML = saveStateHtml(plan);
    }
    function replaceDay(plan, di, focusSel) {
      var list = $('.days', root);
      var nc = dayItem(plan, plan.days[di], di);
      list.replaceChild(nc, list.children[di]);
      refreshHead();
      if (focusSel) { var el = $(focusSel, nc); if (el && !el.disabled) el.focus(); else { var alt = $('[data-a="replace"]', nc); if (alt) alt.focus(); } }
    }
    function openReplace(plan, di, mi) {
      var showAll = false;
      var meal = plan.days[di].meals[mi];
      var content = h('<div class="replace"><p class="muted small">' + U.esc(Models.mealName(meal.slot)) + ', ' + U.esc(U.formatDate(plan.days[di].date, { day: 'numeric', month: 'long' })) +
        '. Порции подобраны автоматически, сверху — блюда, с которыми день ближе всего к норме ' + plan.settings.targets.kcal + ' ккал.</p>' +
        UI.switchHtml('rp-all', 'Показать блюда для любого приёма пищи', false) + '<ul class="replace-list"></ul></div>');
      function list() {
        var cands = Planner.replacementCandidates(plan, di, mi, showAll);
        var ul = $('.replace-list', content);
        if (!cands.length) { ul.innerHTML = '<li class="muted">Подходящих блюд нет. Добавьте рецепты с приёмом пищи «' + U.esc(Models.mealName(meal.slot)) + '» или разрешите больше продуктов.</li>'; return; }
        ul.innerHTML = cands.map(function (c, i) {
          var pct = Math.round(c.dev * 100);
          var lvl = Math.abs(c.dev) <= 0.1 ? 'ok' : Math.abs(c.dev) <= 0.2 ? 'warn' : 'bad';
          return '<li><button type="button" class="replace-opt" data-i="' + i + '">' + UI.mediaHtml(c.recipe, 'ro-media') +
            '<span class="ro-body"><span class="ro-title">' + U.esc(c.recipe.title) + '</span>' +
            '<span class="ro-meta">' + U.fmt(c.portions, 1) + ' ' + U.plural(Math.ceil(c.portions), 'порция', 'порции', 'порций') + ', ' + U.fmt(c.kcal) + ' ккал. За день выйдет ' + U.fmt(c.dayKcal) + ' ккал <span class="dev-pill dev-' + lvl + '">' + (pct > 0 ? '+' : pct < 0 ? '−' : '') + Math.abs(pct) + '%</span>' +
            (c.sameDay ? ' <span class="badge badge-warn">уже есть в этот день</span>' : '') + (c.weekCount >= Planner.MAX_PER_WEEK ? ' <span class="badge badge-warn">уже ' + c.weekCount + ' раза за неделю</span>' : '') + '</span></span></button></li>';
        }).join('');
        ul._cands = cands;
      }
      var m = UI.modal({ title: 'Заменить блюдо', content: content, size: 'md' });
      var sw = $('#rp-all', content);
      sw.addEventListener('click', function () { showAll = !showAll; sw.setAttribute('aria-checked', String(showAll)); list(); });
      $('.replace-list', content).addEventListener('click', function (e) {
        var b = e.target.closest('[data-i]'); if (!b) return;
        var c = $('.replace-list', content)._cands[Number(b.dataset.i)];
        Planner.replaceMeal(plan, di, mi, c.recipe.id, c.portions);
        DB.save('plan');
        m.close();
        replaceDay(plan, di, '.meals > li:nth-child(' + (mi + 1) + ') [data-a="replace"]');
        UI.toast('Блюдо заменено на «' + c.recipe.title + '»');
      });
      list();
    }
    function buildShopping() {
      var plan = DB.state.plan; if (!plan) return;
      var people = plan.settings.people || S().people || 1;
      function run(mode) {
        if (!mode) return;
        if (mode === 'replace') DB.state.shopping = [];
        plan.days.forEach(function (d) {
          d.meals.forEach(function (m) {
            var r = m.recipeId && DB.recipe(m.recipeId);
            if (r) Shopping.addRecipe(r, m.portions * people, 'plan');
          });
        });
        if (DB.save('shopping')) UI.toast('Продукты на неделю добавлены в список покупок (на ' + people + ' ' + peopleWord(people) + ')', { actionLabel: 'Открыть список', onAction: function () { location.hash = '#shopping'; } });
      }
      if (!DB.state.shopping.length) { run('replace'); return; }
      UI.choose({ title: 'Добавить продукты в список покупок', text: 'В списке уже ' + DB.state.shopping.length + ' ' + U.plural(DB.state.shopping.length, 'позиция', 'позиции', 'позиций') + '. Количество продуктов рассчитано на ' + people + ' ' + peopleWord(people) + '.',
        options: [{ value: 'append', label: 'Добавить к текущему списку', desc: 'Одинаковые продукты сложатся в одну позицию', primary: true }, { value: 'replace', label: 'Заменить текущий список', desc: 'Сейчас в списке всё удалится' }] }).then(run);
    }
    return { render: render };
  })();

  /* =======================================================================
   * UI: Настройки — тема, категории, справочник продуктов, данные
   * ======================================================================= */
  var SettingsView = (function () {
    var root = null;
    var prodQuery = '', prodOnlyMine = false, prodLimit = 40;
    function render() {
      root = h('<section class="view" aria-labelledby="h-settings">' +
        '<div class="view-head"><div><h1 id="h-settings" tabindex="-1">Настройки</h1></div></div>' +
        '<div class="settings-grid">' +
        '<section class="card" aria-labelledby="st-theme"><h2 class="card-title" id="st-theme">Оформление</h2>' +
        UI.switchHtml('set-dark', 'Тёмная тема', Theme.current() === 'dark', ' data-theme-toggle') +
        '<p class="muted small">При первом запуске тема берётся из настроек системы.</p></section>' +
        '<section class="card" aria-labelledby="st-data"><h2 class="card-title" id="st-data">Данные и резервная копия</h2>' +
        '<p class="muted small">Всё хранится только в этом браузере. Сохраните JSON-копию, чтобы перенести данные на другое устройство.</p>' +
        '<div class="btn-col"><button type="button" class="btn btn-secondary" data-a="export">Экспорт данных (JSON)</button>' +
        '<label class="btn btn-secondary btn-file">Импорт данных…<input type="file" accept="application/json,.json" class="sr-only" id="imp-file"></label>' +
        '<button type="button" class="btn btn-ghost btn-danger-text" data-a="reset">Сбросить к демо-данным</button></div>' +
        '<dl class="storage-usage small" id="storage-usage" aria-live="polite"></dl></section>' +
        '<section class="card" aria-labelledby="st-cats"><h2 class="card-title" id="st-cats">Категории списка покупок</h2>' +
        '<p class="muted small">Порядок повторяет ваш маршрут по магазину.</p><ol class="cat-list"></ol>' +
        '<form class="inline-form" id="cat-add" novalidate><div class="field"><label for="cat-new" class="sr-only">Новая категория</label><input id="cat-new" type="text" placeholder="Новая категория" maxlength="40"></div><button class="btn btn-secondary" type="submit">Добавить</button></form></section>' +
        '<section class="card card-wide" aria-labelledby="st-prods"><h2 class="card-title" id="st-prods">Справочник продуктов</h2>' +
        '<div class="prod-tools"><div class="field"><label for="prod-q" class="sr-only">Поиск продукта</label><input id="prod-q" type="search" placeholder="Поиск продукта"></div>' +
        UI.switchHtml('prod-mine', 'Только добавленные мной', prodOnlyMine) + '<button type="button" class="btn btn-primary" data-a="new-prod">＋ Продукт</button></div>' +
        '<div class="prod-table" role="region" aria-label="Список продуктов"></div></section>' +
        '</div></section>');
      var dark = $('#set-dark', root);
      dark.addEventListener('click', function () { Theme.toggle(); });
      $('[data-a="export"]', root).addEventListener('click', function (e) {
        var btn = e.currentTarget; btn.disabled = true;
        Backup.exportJSON().then(function (r) {
          UI.toast('Резервная копия сохранена: ' + r.name + (r.photos ? ' (с фото: ' + r.photos + ', ' + U.fmt(r.bytes / 1024 / 1024, 1) + ' МБ)' : ''));
        }).catch(function (err) { UI.toast('Не удалось экспортировать: ' + (err && err.message || err), { type: 'error' }); })
          .then(function () { btn.disabled = false; });
      });
      $('#imp-file', root).addEventListener('change', function (e) {
        var file = e.target.files[0]; e.target.value = '';
        if (!file) return;
        var reader = new FileReader();
        reader.onerror = function () { UI.toast('Не удалось прочитать файл', { type: 'error' }); };
        reader.onload = function () {
          var obj;
          try { obj = JSON.parse(reader.result); } catch (err) { UI.toast('Это не JSON-файл или он повреждён.', { type: 'error' }); return; }
          var v = Backup.validate(obj);
          if (!v.ok) { UI.toast(v.error, { type: 'error' }); return; }
          UI.choose({ title: 'Импорт данных', text: 'В файле: рецептов — ' + v.counts.recipes + ', фото — ' + v.counts.photos + ', продуктов — ' + v.counts.products + ', позиций списка — ' + v.counts.shopping + ', в холодильнике — ' + v.counts.fridge + '.',
            options: [{ value: 'merge', label: 'Объединить', desc: 'Добавить новое, совпадающие рецепты обновить по дате', primary: true },
              { value: 'replace', label: 'Заменить всё', desc: 'Текущие данные будут полностью заменены' }] }).then(function (mode) {
            if (!mode) return;
            Backup.importData(v.data, mode).then(function (ok) {
              if (!ok) return;
              Theme.apply(DB.state.settings.theme === 'dark' || DB.state.settings.theme === 'light' ? DB.state.settings.theme : Theme.current());
              if (DB.state.settings.theme) Storage.set('theme', DB.state.settings.theme);
              UI.toast(mode === 'merge' ? 'Данные объединены' : 'Данные восстановлены из копии');
              Router.refresh();
            }).catch(function (err) { UI.toast('Импорт не удался: ' + (err && err.message || err), { type: 'error' }); });
          });
        };
        reader.readAsText(file);
      });
      $('[data-a="reset"]', root).addEventListener('click', function () {
        UI.confirm({ title: 'Сбросить к демо-данным?', text: 'Все ваши рецепты, продукты, список покупок, холодильник и меню будут удалены и заменены демо-набором. Сделайте экспорт, если данные нужны.', okText: 'Сбросить', danger: true }).then(function (yes) {
          if (!yes) return;
          Backup.resetDemo().then(function () { Router.refresh(); UI.toast('Восстановлены демо-данные'); });
        });
      });
      usage();
      renderCats();
      $('#cat-add', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var inp = $('#cat-new', root); var name = inp.value.trim();
        if (!name) { UI.fieldError(inp, 'Введите название'); return; }
        if (DB.state.settings.categories.some(function (c) { return U.norm(c.name) === U.norm(name); })) { UI.fieldError(inp, 'Такая категория уже есть'); return; }
        UI.fieldError(inp, null);
        var cats = DB.state.settings.categories;
        var otherIdx = cats.findIndex(function (c) { return c.id === 'other'; });
        cats.splice(otherIdx >= 0 ? otherIdx : cats.length, 0, { id: U.uid('c'), name: name });
        DB.save('settings'); inp.value = ''; renderCats(); UI.toast('Категория «' + name + '» добавлена');
      });
      $('#prod-q', root).addEventListener('input', U.debounce(function (e) { prodQuery = e.target.value; prodLimit = 40; renderProducts(); }, 150));
      var mine = $('#prod-mine', root);
      mine.addEventListener('click', function () { prodOnlyMine = !prodOnlyMine; mine.setAttribute('aria-checked', String(prodOnlyMine)); prodLimit = 40; renderProducts(); });
      $('[data-a="new-prod"]', root).addEventListener('click', function () { openProduct(null); });
      renderProducts();
      return root;
    }
    function usage() {
      var box = $('#storage-usage', root);
      function row(k, v) { return '<div class="su-row"><dt>' + k + '</dt><dd>' + v + '</dd></div>'; }
      var bytes = 0;
      try { Storage.keys().forEach(function (k) { var v = localStorage.getItem(Storage.NS + k); bytes += (k.length + (v ? v.length : 0)) * 2; }); } catch (e) { /* ignore */ }
      var ph = PhotoStore.stats();
      var html = row('Данные (localStorage)', U.fmt(bytes / 1024 / 1024, 2) + ' МБ из ~5 МБ') +
        (PhotoStore.isAvailable()
          ? row('Фото (IndexedDB)', ph.count + ' шт · ' + U.fmt(ph.bytes / 1024 / 1024, 2) + ' МБ')
          : row('Фото', 'IndexedDB недоступна — фото хранятся вместе с данными'));
      box.innerHTML = html;
      PhotoStore.estimate().then(function (est) {
        if (!est || !est.quota || !document.contains(box)) return;
        box.insertAdjacentHTML('beforeend', row('Доступно браузеру', '≈ ' + (est.quota > 1073741824 ? U.fmt(est.quota / 1073741824, 1) + ' ГБ' : U.fmt(est.quota / 1048576) + ' МБ')));
      });
      if (global.navigator && navigator.storage && navigator.storage.persisted) {
        navigator.storage.persisted().then(function (p) {
          if (document.contains(box)) box.insertAdjacentHTML('beforeend', row('Защита от автоочистки', p ? 'включена' : 'нет (браузер может удалить данные при нехватке места)'));
        }).catch(function () {});
      }
    }
    function renderCats(focusSel) {
      var ol = $('.cat-list', root);
      var cats = DB.state.settings.categories;
      ol.innerHTML = cats.map(function (c, i) {
        return '<li class="cat-row" data-i="' + i + '"><input type="text" value="' + U.esc(c.name) + '" aria-label="Название категории ' + (i + 1) + '" maxlength="40">' +
          '<button type="button" class="icon-btn" data-c="up" aria-label="Выше: ' + U.esc(c.name) + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" class="icon-btn" data-c="down" aria-label="Ниже: ' + U.esc(c.name) + '"' + (i === cats.length - 1 ? ' disabled' : '') + '>↓</button>' +
          (c.id === 'other' ? '<span class="icon-btn-spacer" title="Категорию «Прочее» удалить нельзя"></span>' : '<button type="button" class="icon-btn" data-c="del" aria-label="Удалить категорию ' + U.esc(c.name) + '">✕</button>') + '</li>';
      }).join('');
      $$('.cat-row input', ol).forEach(function (inp, i) {
        inp.addEventListener('change', function () {
          var v = inp.value.trim();
          if (!v) { inp.value = cats[i].name; return; }
          cats[i].name = v; DB.save('settings'); UI.toast('Категория переименована');
        });
      });
      ol.onclick = function (e) {
        var b = e.target.closest('[data-c]'); if (!b) return;
        var i = Number(b.closest('.cat-row').dataset.i), a = b.dataset.c;
        if (a === 'up' && i > 0) { var t = cats[i - 1]; cats[i - 1] = cats[i]; cats[i] = t; DB.save('settings'); renderCats('[data-i="' + (i - 1) + '"] [data-c="up"]'); }
        if (a === 'down' && i < cats.length - 1) { var t2 = cats[i + 1]; cats[i + 1] = cats[i]; cats[i] = t2; DB.save('settings'); renderCats('[data-i="' + (i + 1) + '"] [data-c="down"]'); }
        if (a === 'del') {
          var c = cats[i];
          var used = DB.state.products.filter(function (p) { return p.category === c.id; }).length + DB.state.shopping.filter(function (s) { return s.category === c.id; }).length;
          UI.confirm({ title: 'Удалить категорию «' + c.name + '»?', text: used ? 'Продукты и позиции списка из неё (' + used + ') переедут в «Прочее».' : 'Категория пуста.', okText: 'Удалить', danger: true }).then(function (yes) {
            if (!yes) return;
            cats.splice(i, 1);
            DB.state.products.forEach(function (p) { if (p.category === c.id) p.category = 'other'; });
            DB.state.shopping.forEach(function (s) { if (s.category === c.id) s.category = 'other'; });
            DB.save('settings'); DB.save('products'); DB.save('shopping');
            renderCats(); UI.toast('Категория удалена');
          });
        }
      };
      if (focusSel) { var el = $(focusSel, ol); if (el && !el.disabled) el.focus(); }
    }
    function renderProducts() {
      var box = $('.prod-table', root);
      var n = U.norm(prodQuery);
      var list = DB.state.products.filter(function (p) {
        if (prodOnlyMine && !p.isCustom) return false;
        return !n || U.norm(p.name).indexOf(n) >= 0;
      }).sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });
      if (!list.length) {
        box.innerHTML = '';
        box.appendChild(UI.emptyState({ emoji: '🥕', title: prodOnlyMine && !n ? 'Своих продуктов пока нет' : 'Ничего не найдено', text: 'Добавьте продукт — он появится в автоподстановке.', actionLabel: '＋ Добавить продукт', onAction: function () { openProduct(null, prodQuery); } }));
        return;
      }
      var shown = list.slice(0, prodLimit);
      box.innerHTML = '<p class="muted small">Показано ' + shown.length + ' из ' + list.length + ' · значения на 100 г</p><ul class="prod-list">' + shown.map(function (p) {
        var u = p.per100;
        return '<li class="prod-row"><div class="prod-main"><span class="prod-name">' + U.esc(p.name) + (p.isCustom ? ' <span class="badge badge-mine">мой</span>' : '') + '</span>' +
          '<span class="muted small">' + U.esc(DB.categoryName(p.category)) + ' · ' + U.fmt(u.kcal) + ' ккал · Б ' + U.fmt(u.protein, 1) + ' · Ж ' + U.fmt(u.fat, 1) + ' · У ' + U.fmt(u.carbs, 1) + '</span></div>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-edit="' + U.esc(p.id) + '" aria-label="Изменить ' + U.esc(p.name) + '">Изменить</button>' +
          (p.isCustom ? '<button type="button" class="icon-btn" data-delp="' + U.esc(p.id) + '" aria-label="Удалить ' + U.esc(p.name) + '">✕</button>' : '<span class="icon-btn-spacer"></span>') + '</li>';
      }).join('') + '</ul>' + (list.length > prodLimit ? '<button type="button" class="btn btn-secondary btn-block" data-more>Показать ещё</button>' : '');
      box.onclick = function (e) {
        var ed = e.target.closest('[data-edit]'); if (ed) { openProduct(ed.dataset.edit); return; }
        var more = e.target.closest('[data-more]'); if (more) { prodLimit += 60; renderProducts(); return; }
        var del = e.target.closest('[data-delp]');
        if (del) {
          var p = DB.product(del.dataset.delp);
          var inRecipes = Recipes.all().filter(function (r) { return Recipes.containsProduct(r, [p.id]); });
          UI.confirm({ title: 'Удалить «' + p.name + '»?', text: inRecipes.length ? 'Продукт используется в ' + inRecipes.length + ' ' + U.plural(inRecipes.length, 'рецепте', 'рецептах', 'рецептах') + ': ' + inRecipes.slice(0, 3).map(function (r) { return r.title || 'Без названия'; }).join(', ') + '. Там он останется без КБЖУ.' : 'Продукт будет удалён из справочника.', okText: 'Удалить', danger: true }).then(function (yes) {
            if (!yes) return;
            var i = DB.state.products.indexOf(p);
            DB.state.products.splice(i, 1); DB.save('products'); renderProducts();
            UI.toast('Продукт удалён', { actionLabel: 'Отменить', onAction: function () { DB.state.products.splice(i, 0, p); DB.save('products'); renderProducts(); } });
          });
        }
      };
    }
    function openProduct(id, presetName) {
      var p = id ? DB.product(id) : null;
      var d = p ? U.clone(p) : { id: U.uid('p'), name: presetName || '', category: 'other', per100: { kcal: '', protein: '', fat: '', carbs: '', fiber: '' }, units: {}, isCustom: true };
      var form = h('<form class="prod-form" novalidate><div class="form-grid g2">' +
        '<div class="field field-wide"><label for="pe-name">Название <span class="req" aria-hidden="true">*</span></label><input id="pe-name" type="text" maxlength="80" autofocus></div>' +
        '<div class="field field-wide"><label for="pe-cat">Категория</label><select id="pe-cat">' + RecipesView.catOptions(d.category) + '</select></div></div>' +
        '<h3 class="sub-title">КБЖУ на 100 г</h3><div class="form-grid g5">' +
        [['kcal', 'Ккал'], ['protein', 'Белки'], ['fat', 'Жиры'], ['carbs', 'Углеводы'], ['fiber', 'Клетчатка']].map(function (x) {
          return '<div class="field"><label for="pe-' + x[0] + '">' + x[1] + '</label><input id="pe-' + x[0] + '" type="text" inputmode="decimal" value="' + U.esc(String(d.per100[x[0]] == null ? '' : d.per100[x[0]]).replace('.', ',')) + '"></div>';
        }).join('') + '</div>' +
        '<h3 class="sub-title">Вес единиц <span class="muted small">(пусто — не задано)</span></h3><div class="form-grid g4">' +
        [['шт', '1 шт, г'], ['ст. л.', '1 ст. л., г'], ['ч. л.', '1 ч. л., г'], ['мл', 'Плотность, г/мл']].map(function (x, i) {
          return '<div class="field"><label for="pe-u' + i + '">' + x[1] + '</label><input id="pe-u' + i + '" data-unit="' + x[0] + '" type="text" inputmode="decimal" value="' + U.esc(d.units[x[0]] != null ? String(d.units[x[0]]).replace('.', ',') : '') + '"></div>';
        }).join('') + '</div>' + (p && !p.isCustom ? '<p class="muted small">Встроенный продукт можно изменить, но нельзя удалить.</p>' : '') + '</form>');
      $('#pe-name', form).value = d.name;
      var foot = h('<div class="btn-row"><button type="button" class="btn btn-ghost" data-close>Отмена</button><button type="button" class="btn btn-primary" data-a="save">Сохранить</button></div>');
      var m = UI.modal({ title: p ? 'Продукт: ' + p.name : 'Новый продукт', content: form, footer: foot, size: 'md' });
      function save() {
        var ok = true, first = null;
        function bad(el, msg) { UI.fieldError(el, msg); ok = false; first = first || el; }
        var nm = $('#pe-name', form), name = nm.value.trim();
        var dup = DB.findProductByName(name);
        if (!name) bad(nm, 'Введите название'); else if (dup && dup.id !== d.id) bad(nm, 'Такой продукт уже есть'); else UI.fieldError(nm, null);
        var per = {};
        ['kcal', 'protein', 'fat', 'carbs', 'fiber'].forEach(function (k) {
          var el = $('#pe-' + k, form), v = el.value.trim() === '' ? 0 : U.parseNum(el.value);
          if (isNaN(v) || v < 0 || v > (k === 'kcal' ? 900 : 100)) bad(el, k === 'kcal' ? '0–900' : '0–100'); else { UI.fieldError(el, null); per[k] = v; }
        });
        var units = {};
        $$('[data-unit]', form).forEach(function (el) {
          if (el.value.trim() === '') { UI.fieldError(el, null); return; }
          var v = U.parseNum(el.value);
          if (!(v > 0)) bad(el, '> 0'); else { UI.fieldError(el, null); units[el.dataset.unit] = v; }
        });
        if (!ok) { first.focus(); return; }
        var out = Object.assign(d, { name: name, category: $('#pe-cat', form).value, per100: per, units: units });
        if (p) Object.assign(p, out); else DB.state.products.push(out);
        if (!DB.save('products')) return;
        m.close(); renderProducts(); UI.toast(p ? 'Продукт обновлён' : 'Продукт добавлен');
      }
      $('[data-a="save"]', foot).addEventListener('click', save);
      form.addEventListener('submit', function (e) { e.preventDefault(); save(); });
    }
    return { render: render };
  })();

  /* =======================================================================
   * Lib — ленивая загрузка SortableJS с CDN (фиксированная версия)
   * ======================================================================= */
  var Lib = (function () {
    var p = null;
    function loadSortable() {
      if (global.Sortable) return Promise.resolve(global.Sortable);
      if (!p) p = PDF.loadScript('https://cdn.jsdelivr.net/npm/sortablejs@1.15.3/Sortable.min.js', 10000)
        .then(function () { return global.Sortable || null; })
        .catch(function () { p = null; return null; });
      return p;
    }
    return { loadSortable: loadSortable };
  })();

  /* =======================================================================
   * UI/Router — hash-роутинг #recipes / #shopping / #fridge / #plan / #settings
   * ======================================================================= */
  var Router = (function () {
    var routes = {
      recipes: { title: 'Рецепты', view: RecipesView },
      shopping: { title: 'Список покупок', view: ShoppingView },
      fridge: { title: 'Холодильник', view: FridgeView },
      plan: { title: 'Меню на неделю', view: PlanView },
      settings: { title: 'Настройки', view: SettingsView }
    };
    var current = null;
    function route() { var r = (location.hash || '').replace(/^#\/?/, ''); return routes[r] ? r : 'recipes'; }
    function show(focus) {
      var r = route();
      var main = $('#main');
      var scrollY = global.scrollY;
      var node = routes[r].view.render();
      main.innerHTML = '';
      main.appendChild(node);
      document.title = routes[r].title + ' — Foodly!';
      $$('.nav-link').forEach(function (a) {
        if (a.dataset.route === r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      });
      updateBadge();
      if (focus) { global.scrollTo(0, 0); var hd = $('h1', main); if (hd) hd.focus({ preventScroll: true }); }
      else if (current === r) global.scrollTo(0, scrollY);
      current = r;
    }
    function updateBadge() {
      var left = DB.state.shopping.filter(function (x) { return !x.checked; }).length;
      $$('.nav-count').forEach(function (b) { b.textContent = left ? String(left) : ''; b.hidden = !left; });
    }
    function init() {
      global.addEventListener('hashchange', function () { show(true); });
      if (!location.hash) history.replaceState(null, '', '#recipes');
      show(false);
      DB.onChange(function (k) { if (k === 'shopping' || k === '*') updateBadge(); });
    }
    return { init: init, refresh: function () { show(false); }, current: function () { return current; } };
  })();
  Foodly.Router = Router;

  /* =======================================================================
   * PWA — регистрация сервис-воркера и тост об обновлении
   * ======================================================================= */
  var PWA = (function () {
    function init() {
      if (!('serviceWorker' in navigator)) return;
      if (location.protocol !== 'http:' && location.protocol !== 'https:') return; // на file:// работаем без SW
      var refreshing = false, userAccepted = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        // перезагружаемся только после «Обновить», а не при первой установке SW
        if (refreshing || !userAccepted) return; refreshing = true; location.reload();
      });
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        function prompt(worker) {
          UI.toast('Доступно обновление', { actionLabel: 'Обновить', timeout: 0, onAction: function () { userAccepted = true; worker.postMessage({ type: 'SKIP_WAITING' }); } });
        }
        if (reg.waiting && navigator.serviceWorker.controller) prompt(reg.waiting);
        reg.addEventListener('updatefound', function () {
          var w = reg.installing; if (!w) return;
          w.addEventListener('statechange', function () {
            if (w.state === 'installed' && navigator.serviceWorker.controller) prompt(w);
          });
        });
        setInterval(function () { reg.update().catch(function () {}); }, 60 * 60 * 1000);
      }).catch(function (e) { console.warn('[Foodly] SW registration failed', e); });
    }
    return { init: init };
  })();
  Foodly.PWA = PWA;

  /* =======================================================================
   * Init
   * ======================================================================= */
  function boot() {
    Storage.setErrorHandler(function (msg) { UI.toast(msg, { type: 'error', timeout: 9000 }); });
    DB.init();
    Theme.init();
    $$('[data-theme-toggle]').forEach(function (b) {
      if (b.closest('#main')) return;
      b.addEventListener('click', function () { Theme.toggle(); });
    });
    // Битые ссылки на фото → заглушка
    document.addEventListener('error', function (e) {
      var img = e.target;
      if (img && img.tagName === 'IMG' && img.dataset.fallback) {
        // уменьшенная копия Commons не нашлась — пробуем оригинал, потом заглушка
        var orig = PhotoStore.originalOf(img.getAttribute('src'));
        if (orig && !img.dataset.origTried) { img.dataset.origTried = '1'; img.src = orig; return; }
        var tpl = img.nextElementSibling;
        if (tpl && tpl.tagName === 'TEMPLATE') img.replaceWith(tpl.content.cloneNode(true));
      }
    }, true);
    // Фото: открываем IndexedDB, переносим старые base64-фото, убираем «сирот» — затем рисуем интерфейс
    PhotoStore.init().then(function (ok) {
      if (!ok) return null;
      return PhotoStore.migrateInline().then(function () { PhotoStore.fixDangling(); return PhotoStore.gc(); });
    }).catch(function (e) { console.warn('[Foodly] photos init', e); }).then(function () {
      Router.init();
      PWA.init();
      if (location.protocol === 'http:' || location.protocol === 'https:') PhotoStore.persist();
      // локальные копии фото по ссылкам — в фоне, чтобы не тормозить запуск
      setTimeout(function () { PhotoStore.cacheRemote(); }, 1500);
      global.addEventListener('online', function () { PhotoStore.cacheRemote(); });
      document.documentElement.classList.add('app-ready');
    });
  }
  Foodly.boot = boot;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
