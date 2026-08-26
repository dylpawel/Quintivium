# Specyfikacja Silnika Zagadek i Pytań LOGIC-APP

Dokumentacja techniczna struktury danych JSON, formatowania treści oraz obsługiwanych znaczników dla otwartych pytań logicznych i matematycznych.

---

## 1. Architektura Wyświetlania Pytań

Silnik przetwarza pole `question` przy użyciu prostej detekcji typu treści:
1. **HTML / SVG Mode:** Jeśli ciąg znaków po usunięciu białych znaków na początku (`trimStart()`) zaczyna się od znaku `<`, silnik wstawia zawartość do kontenera za pomocą `innerHTML`.
2. **Standard Text Mode:** W przeciwnym razie treść wstawiana jest jako bezpieczny tekst (`textContent`).
3. **KaTeX Engine:** Wykrycie znaku `$` w dowolnym miejscu ciągu inicjuje automatyczne renderowanie formuł matematycznych.

---

## 2. Struktura Obiektu JSON

Dane pytań muszą być przechowywane jako tablica obiektów JSON. Każdy obiekt reprezentuje jedno otwarte pytanie z numeryczną lub tekstową odpowiedzią.

```JSON
[
  {
    "question": "<svg ...>...</svg>\nTreść pytania z elementem <b>bold</b> oraz równaniem $x^2 = 9$.",
    "answers": ["3", "-3"],
    "hint": "Opcjonalna podpowiedź wspierająca formatowanie HTML i KaTeX: $x = \\sqrt{9}$."
  }
]
```

### Opis pól:

- **question** (string, wymagane): Główna treść pytania. Może zawierać nagłówek SVG, formatowanie HTML oraz wzory KaTeX.
- **answers** (array[string], wymagane): Tablica akceptowalnych poprawnych odpowiedzi (zawsze jako ciągi tekstowe string).
- **hint** (string, opcjonalne): Podpowiedź dla użytkownika. Działają w niej te same reguły formatowania co w question.

---

## 3. Składnia i Formatowanie Treści

### A. Grafika Wektorowa (SVG)
Dla pytań wizualnych kod SVG **musi znajdować się na samym początku** pola `question`, aby aktywować renderowanie przez `innerHTML`.

- **Stylizacja wyśrodkowania:** `style="display:block; margin:0 auto 15px;"`
- **Skalowanie:** Używaj atrybutu `viewBox="0 0 W H"` dla zapewnienia responsywności na różnych ekranach.
- **Czysty kod:** Polegaj na wbudowanych właściwościach wektorowych (`fill`, `stroke`, `stroke-width`).

### B. Formatowanie Tekstu (HTML)
Silnik **nie wspiera** składni Markdown (np. `**tekst**`). Używaj natywnych znaczników HTML:

- **Pogrubienie:** `<b>tekst</b>` lub `<strong>tekst</strong>`
- **Kursywa:** `<i>tekst</i>` lub `<em>tekst</em>`
- **Nowa linia:** `<br>` lub akapity `<p>`
- **Wyróżnienia kolorystyczne:** `<span style="color: #0074D9;">tekst</span>`

### C. Wzory Matematyczne (KaTeX / LaTeX)
KaTeX aktywuje się automatycznie po wykryciu znaku `$`.

- **Tryb wewnątrzlinijkowy (Inline):** `$składnia$` (np. `$x + 2 = 5$`)
- **Najważniejsze komendy:**
  - Ułamki: `\frac{a}{b}`
  - Pierwiastki: `\sqrt{x}`
  - Potęgi i indeksy: `x^2`, `y_1`
  - Mnożenie: `\cdot` lub `\times`
  - Symbole: `\alpha`, `\beta`, `\pi`, `\le`, `\ge`

---

## 4. Podstawowe Zasady i Dobre Praktyki

1. **Brak spacji na początku SVG:** Upewnij się, że ciąg nie zaczyna się od spacji przed `<svg`, aby funkcja rozpoznawania kodu HTML zadziałała poprawnie.
2. **Ciągi znaków w odpowiedziach:** Odpowiedzi w tablicy `answers` zapisuj zawsze jako ciągi tekstowe (`["16"]`, a nie `[16]`).
3. **Unikanie wewnętrznych stylów CSS:** Nie używaj bloków `<style>` wewnątrz tagów SVG/HTML – polegaj na atrybutach stylów bezpośrednich (`inline styles`) lub klasach kontenera nadrzędnego.

---

## 5. Przykład Gotowego Obiektu

```JSON
{
  "question": "<svg style=\"display:block;margin:0 auto 15px\" width=\"160\" height=\"160\" viewBox=\"0 0 160 160\" xmlns=\"[http://www.w3.org/2000/svg](http://www.w3.org/2000/svg)\">\n  <rect x=\"20\" y=\"40\" width=\"80\" height=\"80\" fill=\"#7FDBFF\" fill-opacity=\"0.5\" stroke=\"#0074D9\" stroke-width=\"2\"/>\n  <circle cx=\"100\" cy=\"80\" r=\"40\" fill=\"#FF851B\" fill-opacity=\"0.5\" stroke=\"#FF851B\" stroke-width=\"2\"/>\n  <text x=\"45\" y=\"85\" font-size=\"14\" font-weight=\"bold\" fill=\"#333\">8</text>\n  <text x=\"85\" y=\"85\" font-size=\"14\" font-weight=\"bold\" fill=\"#333\">5</text>\n  <text x=\"120\" y=\"85\" font-size=\"14\" font-weight=\"bold\" fill=\"#333\">11</text>\n</svg>\nDiagram przedstawia niebieski kwadrat i pomarańczowe koło. Jaka jest suma liczb znajdujących się <b>wewnątrz koła</b>?",
  "answers": ["16"],
  "hint": "Dodaj do siebie tylko te liczby, które leżą wewnątrz okręgu: $5 + 11$."
}
```