import { withTerms } from '../content/glossary';

/** a text with its glossary terms underlined; hovering one shows what it means */
export function WithTerms({ text }: { text: string }) {
  return (
    <>
      {withTerms(text).map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <abbr key={i} className="term" title={p.def}>
            {p.term}
          </abbr>
        ),
      )}
    </>
  );
}
