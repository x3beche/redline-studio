/** Notes to start from: written by hand, the same for everyone, in the
 *  language the app is in. Each shows the note's own syntax by using it -
 *  the first line is the title, `#tags`, `@board-or-model`, `- [ ]` boxes,
 *  a table. `{date}` becomes today's date when one is picked. */
export interface NoteTemplate { id: string; icon: string; name: string; line: string; en: string; tr: string }

export const NOTE_TEMPLATES: NoteTemplate[] = [
  {
    id: 'change', name: 'Design change', line: 'What changed and why, with what follows',
    icon: 'M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4',
    en: `Design change: what, on which part

#change @model-name

What changes:
- The old way, and the new one

Why:
- What it fixes or makes possible

- [ ] Update the drawing
- [ ] Check what it touches (fit, clearance, other parts)
- [ ] Tell whoever builds it`,
    tr: `Tasarım değişikliği: ne, hangi parçada

#değişiklik @model-adı

Ne değişiyor:
- Eskisi nasıldı, yenisi nasıl

Neden:
- Neyi düzeltiyor ya da neyi mümkün kılıyor

- [ ] Çizimi güncelle
- [ ] Neye dokunduğuna bak (oturma, boşluk, diğer parçalar)
- [ ] Üretecek kişiye haber ver`,
  },
  {
    id: 'bug', name: 'Problem found', line: 'Where it happens, the steps, expected and actual',
    icon: 'M12 4l9 16H3z M12 10v4.5 M12 17.2v.1',
    en: `Problem: in a few words

#bug @board-name

Where it happens:
- Board, connector or firmware version

Steps:
1. What was done first
2. Then what

Expected: what should happen
Actual: what happens instead

- [ ] Find the cause
- [ ] Fix it and test again`,
    tr: `Sorun: birkaç kelimeyle

#hata @kart-adı

Nerede oluyor:
- Kart, konnektör ya da firmware sürümü

Adımlar:
1. Önce ne yapıldı
2. Sonra ne

Beklenen: ne olmalıydı
Olan: onun yerine ne oluyor

- [ ] Nedenini bul
- [ ] Düzelt ve yeniden test et`,
  },
  {
    id: 'todo', name: 'To-do list', line: 'Boxes to tick; To-do collects the open ones',
    icon: 'M4 6.5l1.5 1.5L8 5.5 M11 7h9 M4 12.5l1.5 1.5L8 11.5 M11 13h9 M4.5 17.5h3v3h-3z M11 19h9',
    en: `To-do

#todo

- [ ] The first thing to do
- [ ] The next one
- [x] A done one stays, ticked
- [ ] The To-do filter on the left lists the notes with open boxes`,
    tr: `Yapılacaklar

#yapılacak

- [ ] Yapılacak ilk iş
- [ ] Sıradaki
- [x] Biten işaretli kalır
- [ ] Soldaki Yapılacak filtresi açık kutusu olan notları listeler`,
  },
  {
    id: 'meeting', name: 'Meeting notes', line: 'Who was there, what was decided, who does what',
    icon: 'M9 11a3 3 0 1 0 0-6a3 3 0 1 0 0 6z M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5 M16 5.3a3 3 0 0 1 0 5.4 M17.5 14.7c1.6.6 2.6 2 3 4.3',
    en: `Meeting {date}: the subject

#meeting

People: who was there

Talked about:
- The first topic

Decided:
- What was agreed

Action items:
- [ ] Who - what - by when`,
    tr: `Toplantı {date}: konu

#toplantı

Katılanlar: kimler vardı

Konuşulanlar:
- İlk konu

Kararlar:
- Ne üzerinde anlaşıldı

Yapılacaklar:
- [ ] Kim - ne - ne zamana`,
  },
  {
    id: 'order', name: 'Parts to order', line: 'Part, quantity and LCSC link, ticked when ordered',
    icon: 'M4 8l8-4 8 4v8l-8 4-8-4z M4 8l8 4 8-4 M12 12v8',
    en: `Parts to order for @board-name

#order

| Part | Qty | LCSC / link |
| --- | --- | --- |
| 10k resistor, 0603 | 100 | C25804 |
| | | |

- [ ] Ordered
- [ ] Arrived and checked`,
    tr: `@kart-adı için sipariş edilecek parçalar

#sipariş

| Parça | Adet | LCSC / bağlantı |
| --- | --- | --- |
| 10k direnç, 0603 | 100 | C25804 |
| | | |

- [ ] Sipariş verildi
- [ ] Geldi ve kontrol edildi`,
  },
  {
    id: 'test', name: 'Test log', line: 'Setup, measurements and the result',
    icon: 'M3 12h4l2-5 3 10 3-8 2 3h4',
    en: `Test {date}: what was tested

#test @board-name

Setup:
- Supply: 12 V, current limit
- Firmware: version
- Instruments: multimeter, scope

Measurements:

| Point | Expected | Measured |
| --- | --- | --- |
| 3V3 rail | 3.30 V | |

Result: pass or fail, and what to look at next

- [ ] Repeat after the fix`,
    tr: `Test {date}: ne test edildi

#test @kart-adı

Düzen:
- Besleme: 12 V, akım sınırı
- Firmware: sürüm
- Cihazlar: multimetre, osiloskop

Ölçümler:

| Nokta | Beklenen | Ölçülen |
| --- | --- | --- |
| 3V3 hattı | 3,30 V | |

Sonuç: geçti ya da kaldı, sırada neye bakılacak

- [ ] Düzeltmeden sonra tekrarla`,
  },
  {
    id: 'idea', name: 'Idea', line: 'One line and #idea, to find it again later',
    icon: 'M9 18h6 M10 21h4 M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
    en: `Idea: in one line

#idea

Why it might be worth it, in a sentence or two.`,
    tr: `Fikir: tek satırda

#fikir

Neden değebilir, bir iki cümleyle.`,
  },
  {
    id: 'agent', name: 'For the agent', line: 'A request; Send to an agent hands it to a room\'s agent',
    icon: 'M5 12h12 M12 6l6 6-6 6',
    en: `For the agent: what you want done

#agent @model-name

Change:
- What to change, on which board or model

Keep as it is:
- What must not move

Done when:
- How you will know it is right`,
    tr: `Ajan için: ne yapılmasını istiyorsunuz

#ajan @model-adı

Değişecek:
- Neyin, hangi kart ya da modelde değişeceği

Aynı kalacak:
- Neyin yerinden oynamaması gerektiği

Bitti sayılır:
- Doğru olduğunu nasıl anlayacağınız`,
  },
];
