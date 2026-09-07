import { describe, expect, it } from 'vitest';
import { quickJudge } from './quick-judge';

const base = {
  question: '¿Qué arquero atajó dos penales en la final del Mundial 2022?',
  answer: 'Emiliano Martínez',
  accept: ['Dibu Martínez', 'Dibu'],
};

const judge = (given: string, over = base) => quickJudge({ ...over, given });

describe('lo que se resuelve sin molestar a nadie', () => {
  it('la respuesta exacta', () => {
    expect(judge('Emiliano Martínez')?.verdict).toBe('correcta');
  });

  it('sin tildes, en minúsculas y con puntuación de más', () => {
    expect(judge('emiliano martinez!')?.verdict).toBe('correcta');
    expect(judge('  EMILIANO   MARTINEZ  ')?.verdict).toBe('correcta');
  });

  it('una variante aceptada', () => {
    expect(judge('dibu')?.verdict).toBe('correcta');
    expect(judge('el Dibu Martinez')?.verdict).toBe('correcta');
  });

  it('la respuesta dicha entre otras palabras, como sale hablando', () => {
    expect(judge('creo que fue emiliano martinez')?.verdict).toBe('correcta');
    expect(judge('eh… el dibu martinez, no?')?.verdict).toBe('correcta');
  });

  it('rendirse, en las formas en que uno se rinde', () => {
    for (const texto of ['', '   ', 'no sé', 'ni idea', 'paso', 'NS']) {
      expect(judge(texto)).toEqual({ verdict: 'incorrecta', reason: 'No contestó' });
    }
  });

  it('los artículos no cambian nada', () => {
    const maradona = { question: '¿Quién?', answer: 'El Diego', accept: [] };
    expect(judge('diego', maradona)?.verdict).toBe('correcta');
    expect(judge('el diego', maradona)?.verdict).toBe('correcta');
  });
});

describe('lo que se deja para la IA', () => {
  it('un sinónimo que hay que entender', () => {
    expect(judge('el arquero de la selección')).toBeNull();
  });

  it('un número escrito con letras', () => {
    const mundial = { question: '¿En qué año?', answer: '1930', accept: [] };
    expect(judge('mil novecientos treinta', mundial)).toBeNull();
  });

  it('el apellido perdido en una frase larga lo decide la IA', () => {
    // El apellido suelto sí se resuelve acá, pero metido entre otras palabras
    // vuelve a ser ambiguo: puede estar nombrando a otro.
    expect(judge('martinez el arquero de aston villa')).toBeNull();
    expect(judge('un arquero del aston villa')).toBeNull();
  });

  it('una respuesta claramente distinta', () => {
    expect(judge('messi')).toBeNull();
  });
});

describe('no regala puntos', () => {
  it('una respuesta corta no puede aparecer dentro de otra palabra', () => {
    // "oro" adentro de "toronto" no es haber dicho "oro".
    const corta = { question: '¿Qué metal?', answer: 'oro', accept: [] };
    expect(judge('toronto', corta)).toBeNull();
    expect(judge('oro', corta)?.verdict).toBe('correcta');
  });

  it('nombrar la respuesta al revés no alcanza para cantarla', () => {
    expect(judge('martinez emiliano')).toBeNull();
  });

  it('sin respuesta canónica no inventa un veredicto', () => {
    expect(quickJudge({ question: 'q', answer: '', accept: [], given: 'algo' })).toBeNull();
  });
});

describe('errores de tipeo y de dictado, que en una mesa son la norma', () => {
  it('una letra cambiada sigue siendo la respuesta', () => {
    expect(judge('emiliano martines')?.verdict).toBe('correcta');
    expect(judge('emiliano martinez')?.verdict).toBe('correcta');
    expect(judge('emliano martinez')?.verdict).toBe('correcta');
  });

  it('el apellido solo alcanza, si es distintivo', () => {
    expect(judge('martinez')?.verdict).toBe('correcta');
    expect(judge('martines')?.verdict).toBe('correcta');
  });

  it('pero un apellido corto y común no se regala', () => {
    const cruz = { question: '¿Quién?', answer: 'Juan Cruz', accept: [] };
    expect(judge('cruz', cruz)).toBeNull();
    const perez = { question: '¿Quién?', answer: 'Ana Paz', accept: [] };
    expect(judge('paz', perez)).toBeNull();
  });

  it('en respuestas cortas no se perdona nada: cambian de significado', () => {
    const anio = { question: '¿En qué año?', answer: '1930', accept: [] };
    expect(judge('1930', anio)?.verdict).toBe('correcta');
    // 1936 no es 1930, por más que se parezcan.
    expect(judge('1936', anio)).toBeNull();
    const pais = { question: '¿Qué país?', answer: 'Perú', accept: [] };
    expect(judge('peru', pais)?.verdict).toBe('correcta');
    expect(judge('peruano', pais)).toBeNull();
  });

  it('dos nombres distintos que se parecen no se confunden', () => {
    const messi = { question: '¿Quién?', answer: 'Lionel Messi', accept: [] };
    expect(judge('lionel scaloni', messi)).toBeNull();
  });
});
