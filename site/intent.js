// Search-term intent classifier for GBP keyword impressions.
// 1) exact match against the hand-labelled terms from the GBP tracker (site/intent_labels.json)
// 2) otherwise rules, aware of each hub's street address.
// Works in the browser (window.Intent) and in Node (module.exports) for testing.
(function (root) {
  "use strict";

  const CATS = [
    { key: "buyer",      label: "Купівельний намір",        group: "buyer" },
    { key: "brand",      label: "Бренд або адреса хабу",     group: "brand" },
    { key: "geo",        label: "Пошук за містом",           group: "geo" },
    { key: "generic",    label: "Загальний або пошук роботи", group: "generic" },
    { key: "competitor", label: "Інша компанія",              group: "generic" },
    { key: "poi",        label: "Вантажні об’єкти поруч",     group: "noise" },
    { key: "address",    label: "Сусідня адреса",             group: "noise" },
    { key: "consumer",   label: "Побутове, не за темою",      group: "noise" },
  ];
  // Five groups for charts (validated categorical order: s1..s5)
  const GROUPS = [
    { key: "buyer",   label: "Купівельний намір",   color: "--s1" },
    { key: "brand",   label: "Бренд або адреса",    color: "--s3" },
    { key: "geo",     label: "Пошук за містом",     color: "--s4" },
    { key: "generic", label: "Загальні й конкуренти", color: "--s2" },
    { key: "noise",   label: "Шум",                 color: "--neutral-series" },
  ];
  const CAT = Object.fromEntries(CATS.map(c => [c.key, c]));

  const RX = {
    brand: /fr[ei]+t+y|freity|fritty|фрейт|фрит/,
    cyrillic: /[а-яіїєґ]/,
    poi: /truck ?stop|truck ?wash|travel (center|plaza|centre)|\bpilot\b|flying j|love'?s travel|\bloves\b|\bta (petro|travel)|\bpetro\b|intermodal|\brail\b|railyard|rail ?yard|\bramp\b|\byard\b|\bbnsf\b|union pacific|\bup\b yard|\bterminal\b|truck parking|weigh station|cat scale|blue beacon|jubitz|thorntons|speedway|\btruck (repair|service|tire)|truck stop near/,
    competitor: /\bfedex\b|\bups\b|\busps\b|\bdhl\b|\bxpo\b|\bestes\b|\bsaia\b|old dominion|\bodfl\b|\byrc\b|\babf\b|\br\+l\b|averitt|southeastern freight|central transport|\bdayton freight|\bward trucking|\bpitt ohio|\bgeodis\b|\bryder\b|\bjb hunt|j\.?b\.? hunt|schneider|\bpenske\b|\bnfi\b|\bdsv\b|kuehne|expeditors|\bllc\b|\binc\b|\bcorp\b|\bexpress\b|\bco\.\b/,
    buyer: /cross[\s-]?doc?k|crosdock|\bcros+\b|\bcross\b|transload|trans load|\b3pl\b|logistic|freight|\bcargo\b|drayage|pallet|container|devan|de-?stuff|\bltl\b|\bftl\b|less than truckload|warehousing services|fulfil+ment services|freight forward|shipping (company|services)|\bshipping\b|\bdock rental|bonded/,
    generic: /warehouse|distribution|\bdock\b|\bdocks\b|forklift|\bjobs?\b|hiring|career|employment|staffing|\bamazon\b|walmart|\btarget\b|\bhr\b|\bcommerce\b|industrial|storage|loading|unloading|lumper|\btruck(ing)?\b|\bcarrier\b|\bfacility\b|\bdepot\b|\bpackag/,
    zip: /^\d{5}(-\d{4})?$/,
    consumerPlace: /home depot|lowe'?s home|\bcostco\b|walmart supercenter|\btarget,|airport|restaurant|\bhotel\b|\bmotel\b|\bcafe\b|coffee|pizza|\bbar\b|grill|outlet|\bmall\b|golf|church|school|hospital|\bclinic\b|apartments?\b|\bgym\b|\bpark,|starbucks|mcdonald/,
    addr: /^\d{1,6}[a-z]?\s+\S+|\b\d{2,6}\s+[nsew]\.?\s|\b\d{2,6}\s+\w+\s+(st|street|rd|road|ave|avenue|dr|drive|way|blvd|boulevard|ln|lane|pkwy|parkway|hwy|highway|ct|court|pl|place|cir|circle|ter|trl)\b/,
  };
  const STATES = "alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|ontario|nueva york|nuevo méxico";
  const STATE_RX = new RegExp(`(^|[\\s,])(${STATES}|al|ak|az|ar|ca|co|ct|de|fl|ga|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|usa|us|united states|estados unidos)($|[\\s,])`);

  function norm(t) { return String(t || "").toLowerCase().replace(/\s+/g, " ").trim(); }

  // hubs: [{name, address}] -> street signatures like {num:"375", street:"hazelton"} and city words
  function hubSignatures(hubs) {
    const streets = [], cities = new Set();
    for (const h of hubs || []) {
      const a = norm(h.address);
      const m = /^(\d+)[a-z]?\s+(?:[nsew]\.?\s+)?([a-z0-9]+)/.exec(a);
      if (m) streets.push({ num: m[1], street: m[2] });
      const parts = a.split(",").map(s => s.trim());
      if (parts.length >= 3) cities.add(parts[parts.length - 2]);
      const nameCity = norm(h.name).replace(/\(.*?\)/g, "").split(",")[0].trim();
      if (nameCity) cities.add(nameCity);
    }
    return { streets, cities: Array.from(cities) };
  }

  function rules(term, sig) {
    const t = norm(term);
    if (!t) return "consumer";
    if (RX.brand.test(t) || RX.cyrillic.test(t)) return "brand";
    for (const s of sig.streets) {
      if (new RegExp(`(^|\\D)${s.num}(\\D|$)`).test(t) && t.includes(s.street)) return "brand";
    }
    if (RX.consumerPlace.test(t)) return "consumer";
    if (RX.poi.test(t)) return "poi";
    if (RX.competitor.test(t)) return "competitor";
    // "<company> logistics / transportation / trucking": a named company, not the category
    const head = t.split(",")[0].trim();
    const cm = /^(.+?)\s+(logistics|transportation|transport|trucking|freight|distribution center|fulfillment center)\b/.exec(head);
    if (cm) {
      const prefix = cm[1];
      const isCityPrefix = sig.cities.some(c => prefix === c || prefix.endsWith(" " + c));
      if (!RX.buyer.test(prefix) && !RX.generic.test(prefix) && !isCityPrefix && !STATE_RX.test(prefix) && !/near me|^best |^cheap /.test(prefix)) return "competitor";
    }
    if (RX.buyer.test(t)) return "buyer";
    if (RX.addr.test(t)) return "address";
    if (RX.generic.test(t)) return "generic";
    if (RX.zip.test(t)) return "geo";
    const words = t.replace(/[,.]/g, " ").split(" ").filter(Boolean);
    const isCity = sig.cities.some(c => t === c || t.startsWith(c + " ") || t.startsWith(c + ","));
    if (words.length <= 5 && (isCity || STATE_RX.test(t))) {
      // "costco wholesale, garet place, commack, ny" is a place listing, not a city browse
      const commas = (t.replace(/,\s*(usa|us|united states|estados unidos)$/, "").match(/,/g) || []).length;
      if (commas >= 2) return "consumer";
      return "geo";
    }
    return "consumer";
  }

  function make(hubs, labels) {
    const sig = hubSignatures(hubs);
    const dict = labels || {};
    const cache = new Map();
    function classify(term) {
      const t = norm(term);
      if (cache.has(t)) return cache.get(t);
      const k = dict[t] || rules(t, sig);
      cache.set(t, k);
      return k;
    }
    return { classify, rules: t => rules(t, sig) };
  }

  const api = { CATS, CAT, GROUPS, make, norm, groupOf: k => (CAT[k] || CAT.consumer).group };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Intent = api;
})(typeof window !== "undefined" ? window : globalThis);
