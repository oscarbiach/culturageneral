/** Color plano de cada jugador. El indice `skin` recorre esta lista. */
export const PLAYER_TINTS = [
  'var(--lime)',
  'var(--cyan)',
  'var(--pink)',
  'var(--orange)',
  'var(--violet)',
  'var(--green)',
];

export function tintFor(skin: number): string {
  return PLAYER_TINTS[skin % PLAYER_TINTS.length];
}
