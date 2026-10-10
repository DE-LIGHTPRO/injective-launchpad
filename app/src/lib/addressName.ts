/**
 * A readable, stable name for an address.
 *
 * `inj1de…00000x` is unreadable and unmemorable, so a board of them tells a visitor
 * nothing: they cannot tell whether the same person made three of the launches on
 * screen, which is one of the few judgements the data actually supports.
 * ponsfamily.com solves this with generated names like "SlowNeonThrush" and it works
 * for a reason worth copying: people remember words.
 *
 * DERIVED, NEVER STORED. The name is a pure function of the address, so it needs no
 * backend, no registry and no migration, and the same address is the same name on
 * every device and every render forever.
 *
 * IT IS NOT AN IDENTITY, and the UI must never let it read as one. Two different
 * addresses can collide onto one name, nobody has claimed or verified any of them,
 * and a creator cannot choose theirs. So the address stays visible beside it and the
 * name is a label, not a handle.
 */

/*
 * Word lists sized so the space is large enough to be useful and small enough that
 * every word is readable at a glance. 32 x 32 x 64 is 65,536 names.
 *
 * Deliberately neutral. No word here flatters or disparages, because a generated name
 * attaches to a stranger with no say in it: a launchpad that labelled someone
 * "ShadyCopperRat" by hash would be making an accusation it cannot support.
 */
const ADJECTIVES = [
  'Amber', 'Arctic', 'Bold', 'Bright', 'Calm', 'Candid', 'Clear', 'Cool',
  'Deft', 'Eager', 'Fair', 'Fleet', 'Gentle', 'Glad', 'Grand', 'Keen',
  'Kind', 'Lively', 'Lucid', 'Mild', 'Neat', 'Noble', 'Placid', 'Prime',
  'Quiet', 'Rapid', 'Sleek', 'Solid', 'Spry', 'Steady', 'Vivid', 'Warm',
] as const;

const MATERIALS = [
  'Alder', 'Amber', 'Ash', 'Basalt', 'Birch', 'Brass', 'Bronze', 'Cedar',
  'Chalk', 'Clay', 'Copper', 'Coral', 'Flint', 'Glass', 'Granite', 'Ivory',
  'Jade', 'Linen', 'Marble', 'Oak', 'Onyx', 'Opal', 'Pearl', 'Pine',
  'Quartz', 'Sable', 'Silver', 'Slate', 'Stone', 'Teak', 'Willow', 'Zinc',
] as const;

const ANIMALS = [
  'Albatross', 'Badger', 'Beaver', 'Bison', 'Caracal', 'Chamois', 'Civet', 'Crane',
  'Curlew', 'Dormouse', 'Egret', 'Falcon', 'Ferret', 'Finch', 'Gannet', 'Gecko',
  'Grouse', 'Hare', 'Heron', 'Ibex', 'Jackdaw', 'Kestrel', 'Lemur', 'Lynx',
  'Marlin', 'Marten', 'Meadowlark', 'Mongoose', 'Moose', 'Narwhal', 'Nightjar', 'Ocelot',
  'Orca', 'Osprey', 'Otter', 'Panther', 'Petrel', 'Pika', 'Plover', 'Puffin',
  'Quail', 'Raven', 'Redstart', 'Sable', 'Salmon', 'Sandpiper', 'Serval', 'Shrike',
  'Siskin', 'Skua', 'Sparrow', 'Stoat', 'Swift', 'Tanager', 'Teal', 'Tern',
  'Thrush', 'Toucan', 'Vireo', 'Vole', 'Weasel', 'Whimbrel', 'Wren', 'Yak',
] as const;

/**
 * FNV-1a, 32-bit.
 *
 * Not for security, and it must not be mistaken for it: this is a display label and a
 * collision costs nothing but a repeated word pair. What it does need is to be
 * STABLE and identical everywhere, which rules out anything involving a seed, a
 * locale or a hash that a runtime is free to vary. FNV-1a is twelve lines and the
 * same on every platform.
 */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    // `Math.imul` because `h * 16777619` exceeds 2^53 and starts losing low bits,
    // which would make the name depend on floating point rather than on the address.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The display name for an address: three words, no spaces.
 *
 * Case and surrounding whitespace are normalised first, so the same account written
 * two ways does not get two names.
 */
export function addressName(address: string): string {
  const key = address.trim().toLowerCase();
  if (key.length === 0) return 'Unknown';
  const h = hash32(key);
  /*
   * Different slices of the hash per word. Taking `h % 32` three times would give
   * three correlated choices and collapse most of the space, so each word uses its
   * own bits: 5, 5 and 6.
   */
  const a = ADJECTIVES[h & 31];
  const m = MATERIALS[(h >>> 5) & 31];
  const n = ANIMALS[(h >>> 10) & 63];
  return `${a}${m}${n}`;
}

/** How many distinct names exist, for the test that pins the space. */
export const NAME_SPACE = ADJECTIVES.length * MATERIALS.length * ANIMALS.length;
