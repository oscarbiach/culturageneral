import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Dictado por voz con la API del navegador.
 *
 * Existe en Chrome y en Safari; en el resto simplemente no aparece el boton.
 * Es la forma natural de contestar en una mesa: nadie quiere tipear un apellido
 * mientras el otro lo apura.
 */

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

function recognitionCtor(): (new () => Recognition) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useSpeech(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const ref = useRef<Recognition | null>(null);
  const sink = useRef(onText);
  sink.current = onText;

  const supported = recognitionCtor() !== null;

  const stop = useCallback(() => {
    ref.current?.stop();
    setListening(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    stop();
    const recognition = new Ctor();
    recognition.lang = 'es-AR';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      let text = '';
      for (let i = 0; i < event.results.length; i += 1) text += event.results[i][0].transcript;
      sink.current(text.trim());
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    ref.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }, [stop]);

  useEffect(() => () => ref.current?.stop(), []);

  return { supported, listening, start, stop };
}
