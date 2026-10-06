import { Pipe, PipeTransform, signal } from '@angular/core';

/** English or Turkish, for the words the application says.
 *
 *  The English text is the key: `{{ 'Keep' | t }}`. A word with no Turkish
 *  yet is shown in English rather than as a key, so a room that has not
 *  been translated still reads. Names of things - models, boards, parts,
 *  code - are never translated. The choice is kept in the browser.
 */
export type Lang = 'en' | 'tr';
export const LANGS: { id: Lang; name: string }[] = [{ id: 'en', name: 'English' }, { id: 'tr', name: 'Türkçe' }];

const KEY = 'x3.lang';

function read(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'en' || v === 'tr') return v;
  } catch { /* private window */ }
  return (navigator.language || '').toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

export const LANG = signal<Lang>(read());
document.documentElement.lang = LANG();

export function setLang(l: Lang) {
  LANG.set(l);
  document.documentElement.lang = l;
  try { localStorage.setItem(KEY, l); } catch { /* private window */ }
}

const TR: Record<string, string> = {
  // the tabs
  '3D Drawing': '3D Çizim', 'PCB Design': 'PCB Tasarım', 'Embedded Programming': 'Gömülü Programlama',
  'Web Programming': 'Web Programlama', 'Mobile Programming': 'Mobil Programlama', 'Notes': 'Notlar',
  'Tools': 'Araçlar', 'Basic Tools': 'Temel Araçlar', 'Analytics': 'Analitik',
  // Files (rooms/files.ts)
  'Files': 'Dosyalar',
  'Search files': 'Dosyalarda ara',
  'Drop files here, or click to choose': 'Dosyaları buraya bırakın ya da seçmek için tıklayın',
  'BOM, pick and place, datasheets, photos, STEP - up to 200 MB each': "BOM, pick and place, datasheet, fotoğraf, STEP - her biri 200 MB'a kadar",
  'Uploading…': 'Yükleniyor…',
  'Link to': 'Bağla',
  '(no board)': '(kart yok)',
  'A line about it (optional)': 'Hakkında bir satır (isteğe bağlı)',
  'No files yet - drop the first one above.': 'Henüz dosya yok - ilkini yukarı bırakın.',
  'A BOM linked to a board can be sent to the PCB room: its agent fetches it and converts the board with it.': "Bir karta bağlı BOM, PCB odasına gönderilebilir: oranın agent'ı dosyayı alır ve kartı onunla koda çevirir.",
  "Put a line in a room's thread: what the file is and how to fetch it": "Bir odanın thread'ine bir satır yazar: dosyanın ne olduğu ve nasıl alınacağı",
  'Kept': 'Kaydedildi',
  'Sent to': 'Gönderildi:',
  'Sent to the agent': "Agent'a gönderildi",
  'The upload failed.': 'Yükleme başarısız.',
  'Could not send it.': 'Gönderilemedi.',
  'Could not delete it.': 'Silinemedi.',
  'Pick & place': 'Pick & place',
  'Table': 'Tablo',
  'Archive': 'Arşiv',
  'Text': 'Metin',
  'Other': 'Diğer',
  'Drill': 'Delik',
  '3D mesh': '3D mesh',
  'just now': 'az önce',
  'min ago': 'dk önce',
  'h ago': 'sa önce',
  'someone': 'biri',
  'Analytics, preferences': 'Analitik, tercihler',
  'LLM spend, the machine, energy, the work in each room': 'LLM harcaması, makine, enerji, her odadaki iş',
  // the side columns
  'Part': 'Parça', 'Comment': 'Yorum', 'Save as draft': 'Taslak olarak kaydet', 'Auto English': 'Otomatik İngilizce',
  'Revisions': 'Revizyonlar', 'Board notes': 'Kart notları', 'ask the agent': 'ajana sor', 'Urgent': 'Acil',
  'send': 'gönder', 'message the agent…': 'ajana mesaj yaz…', 'Versions': 'Sürümler', 'snapshot': 'anlık kayıt',
  'queue': 'sıraya al', 'mark applied': 'uygulandı say', 'back to draft': 'taslağa dön', 'edit': 'düzenle',
  'archive': 'arşivle', 'restore': 'geri al', 'delete': 'sil', 'save': 'kaydet', 'cancel': 'vazgeç', 'compare': 'karşılaştır',
  'No revisions yet.': 'Henüz revizyon yok.', 'No notes on code yet.': 'Kodda henüz not yok.', 'Code notes': 'Kod notları',
  'Model': 'Model', 'Folder': 'Klasör', 'Auto archive': 'Otomatik arşiv', 'saving…': 'kaydediliyor…', 'No notes on boards yet.': 'Kartlarda henüz not yok.',
  // the user menu and signing in
  'Members': 'Üyeler', 'Invite people and set what each may do': 'Kişi davet et, her birinin yetkisini belirle',
  'Agent tokens': 'Ajan anahtarları', 'Let an agent work here without the database password': 'Bir ajan veritabanı şifresi olmadan burada çalışsın',
  'Sign out': 'Çıkış yap', 'Workspaces': 'Çalışma alanları', 'New workspace': 'Yeni çalışma alanı',
  'Its own projects, members and agents - nothing shared with this one': 'Kendi projeleri, üyeleri ve ajanları - bununla hiçbir şey paylaşılmaz',
  'Preferences': 'Tercihler', 'Theme, language, keyboard shortcuts': 'Tema, dil, klavye kısayolları',
  'Sign in to continue.': 'Devam etmek için giriş yapın.', 'Sign in': 'Giriş yap', 'Email': 'E-posta', 'Password': 'Şifre',
  'Name': 'Ad', 'Join': 'Katıl', 'Make the account': 'Hesabı oluştur', 'At least 10 characters.': 'En az 10 karakter.',
  'Set the password': 'Şifreyi belirle', 'Close': 'Kapat',
  // preferences
  'Appearance': 'Görünüm', 'Dark': 'Koyu', 'Light': 'Açık', 'Language': 'Dil', 'Keyboard shortcuts': 'Klavye kısayolları', 'Theme': 'Tema',
  'The whole window, the 3D backdrop and the code editor follow it.': 'Tüm pencere, 3D arka plan ve kod editörü buna uyar.',
  'The words Redline says. Names of models, boards, parts and code stay as they are.':
    'Redline\'ın arayüz metinleri. Model, kart, parça adları ve kod olduğu gibi kalır.',
  'Anywhere': 'Her yerde', 'In the code': 'Kodda', 'In Notes': 'Notlarda', 'In a dialog': 'Pencerelerde',
  'Open the command palette: go anywhere, do anything, search everything': 'Komut paletini aç: her yere git, her şeyi yap, her şeyde ara',
  'A quick note, from any room': 'Her odadan hızlı not', 'This page of shortcuts': 'Bu kısayol sayfası',
  'Close a dialog, the palette or the quick note': 'Pencereyi, paleti ya da hızlı notu kapat',
  'Save the open file': 'Açık dosyayı kaydet', 'Go to a file named in an import (Ctrl+click)': 'import satırındaki dosyaya git (Ctrl+tık)',
  'Search in the file / replace': 'Dosyada ara / değiştir', 'Keep the note': 'Notu kaydet', 'A new line': 'Yeni satır',
  'Search notes': 'Notlarda ara', 'Previous / next note': 'Önceki / sonraki not', 'Finish editing': 'Düzenlemeyi bitir',
  'Move in the palette, then open': 'Palette gezin, sonra aç',
  // notes
  'Keep': 'Kaydet', 'All': 'Tümü', 'Pinned': 'Sabitlenmiş', 'To-do': 'Yapılacak', 'Mine': 'Benim',
  'Today': 'Bugün', 'Yesterday': 'Dün', 'This week': 'Bu hafta', 'This month': 'Bu ay', 'Earlier': 'Daha önce',
  'Edit': 'Düzenle', 'Done': 'Bitti', 'Copy': 'Kopyala', 'Copied': 'Kopyalandı', 'Delete': 'Sil',
  'Send to agent…': 'Ajana gönder…', 'Quick note': 'Hızlı not', 'Untitled': 'Başlıksız', 'Nothing matches.': 'Eşleşen yok.',
  'Search notes   /': 'Notlarda ara   /',
  'Just write. First line is the title - #tags, @controller, - [ ] to-dos…':
    'Yazmanız yeterli. İlk satır başlık olur - #etiket, @controller, - [ ] yapılacaklar…',
  'Enter keeps it · Shift+Enter new line': 'Enter kaydeder · Shift+Enter yeni satır',
  'Esc to close · it is kept in Notes': 'Kapatmak için Esc · Notlar\'da saklanır',
  // the command palette
  'Actions': 'İşlemler', 'Rooms': 'Odalar', 'Models': 'Modeller', 'Boards': 'Kartlar', 'Apps': 'Uygulamalar',
  'Chats': 'Sohbetler', 'Parts': 'Parçalar', 'New note': 'Yeni not', 'Show the code': 'Kodu göster',
  'Release the project': 'Projeyi paketle', 'Technical drawing': 'Teknik çizim', 'Build the board': 'Kartı derle',
  '↑↓ to move · Enter to open · Esc to close': '↑↓ gezin · Enter aç · Esc kapat',
  'Go to a model, board, tool or room - search code, notes, chats, parts - or type an action':
    'Model, kart, araç ya da odaya git - kodda, notlarda, sohbetlerde, parçalarda ara - ya da bir işlem yaz',
  // releases, changes, code
  'This firmware is not linked to a board yet.': 'Bu firmware henüz bir karta bağlı değil.',
  'Which board does it run on? The simulator finds its parts from that board.': 'Hangi kartta çalışıyor? Simülatör parçaları o karttan bulur.',
  'Link': 'Bağla',
  'A board that already runs another firmware is usually the right one only if that firmware is this one under another name.': 'Başka bir firmware\'in çalıştığı kart, genelde yalnızca o firmware bununla aynıysa doğru seçimdir.',
  'Cores': 'Çekirdek',
  'What fills it': 'En çok yer kaplayanlar',
  'Cycles per ms': 'ms başına döngü',
  'Peripherals in use': 'Kullanılan çevre birimleri',
  'of': '/',
  'Also on the chip': 'Çipte ayrıca',
  'On the chip, not used by this firmware': 'Çipte var, bu firmware kullanmıyor',
  'Link the app to a board, or build it, to see what it uses.': 'Neleri kullandığını görmek için uygulamayı bir karta bağlayın ya da derleyin.',
  'to check': 'kontrol edilmeli',
  'In the simulation': 'Simülasyonda',
  'channels': 'kanal',
  'in firmware': "firmware'da",
  // the Embedded room: Build, Device, Simulate
  'Board': 'Kart',
  'Ports seen': 'Görülen portlar',
  'none yet': 'henüz yok',
  'Port': 'Port',
  'Probe': 'Programlayıcı',
  'Bridge': 'Köprü',
  'serial port': 'seri port',
  'probe': 'programlayıcı',
  'SWD probe': 'SWD programlayıcı',
  'Serial monitor': 'Seri monitör',
  'Baud rate': 'Baud hızı',
  'time': 'zaman',
  'Clear': 'Temizle',
  'Open': 'Aç',
  'Line ending': 'Satır sonu',
  'none': 'yok',
  'follow': 'takip et',
  'type a line, Enter sends': 'bir satır yazın, Enter gönderir',
  "open a board's port to type to it": 'yazmak için kartın portunu açın',
  'Image': 'İmaj',
  'Built': 'Derlendi',
  'Target': 'Hedef',
  'Size': 'Boyut',
  'Flashing': 'Yükleniyor',
  'Flashing…': 'Yükleniyor…',
  'Last flash': 'Son yükleme',
  'done': 'tamam',
  'failed': 'başarısız',
  'Open the monitor after flashing': 'Yüklemeden sonra monitörü aç',
  'Erase the whole flash first': "Önce tüm flash'ı sil",
  'Flash - build it first': 'Yükle - önce derleyin',
  'Flash - connect a board first': 'Yükle - önce bir kart bağlayın',
  'connecting': 'bağlanıyor',
  'erasing': 'siliniyor',
  'writing': 'yazılıyor',
  'verifying': 'doğrulanıyor',
  'resetting': 'sıfırlanıyor',
  'starting': 'başlıyor',
  'no board connected': 'bağlı kart yok',
  'closed': 'kapalı',
  'opening': 'açılıyor',
  'paused': 'duraklatıldı',
  'paused while flashing': 'yükleme sırasında duraklatıldı',
  'the port went away': 'port kayboldu',
  'in the container': 'konteynerde',
  'looking for ports…': 'portlar aranıyor…',
  'Waiting for a board': 'Kart bekleniyor',
  'What fills flash': "Flash'ı dolduran",
  'Your code': 'Kodunuz',
  'Your code · by file': 'Kodunuz · dosya dosya',
  'Largest in your code': 'Kodunuzdaki en büyükler',
  'C runtime': 'C çalışma kitaplığı',
  'Vendor code': 'Üretici kodu',
  'Where in flash': "Flash'ta nerede",
  'of flash': "flash'ın",
  'more': 'daha',
  'files': 'dosya',
  'symbols': 'sembol',
  'file': 'dosya',
  'library': 'kitaplık',
  'function or table': 'fonksiyon ya da tablo',
  'the smaller ones, together': 'küçükler, bir arada',
  "The project's own sources": 'Projenin kendi kaynakları',
  "The compiler's libraries: libc, libgcc, libstdc++": 'Derleyicinin kitaplıkları: libc, libgcc, libstdc++',
  "ESP-IDF's components": 'ESP-IDF bileşenleri',
  'A vendor HAL and startup code': "Üreticinin HAL'ı ve başlangıç kodu",
  'Areas are bytes. Click a block to look inside it.': 'Alanlar bayt. İçine bakmak için bir bloğa tıklayın.',
  'Click a block to look inside. Esc goes back.': 'İçine bakmak için bir bloğa tıklayın. Esc geri döner.',
  "Click a function or table to make it the note's Part. Esc goes back.": 'Notun parçası yapmak için bir fonksiyona ya da tabloya tıklayın. Esc geri döner.',
  'Reading the build…': 'Derleme okunuyor…',
  'Build once to see what fills flash.': "Flash'ı neyin doldurduğunu görmek için bir kez derleyin.",
  'Build again to see what fills flash: this build predates the sizes.': "Flash'ı neyin doldurduğunu görmek için yeniden derleyin: bu derleme boyut kaydından önce.",
  "None of the project's own files made it into flash.": "Projenin kendi dosyalarından hiçbiri flash'a girmedi.",
  'Changes': 'Değişiklikler',
  'Size vs the previous build': 'Önceki derlemeye göre boyut',
  'since': 'şundan beri',
  'Not built yet.': 'Henüz derlenmedi.',
  'First build: the change shows after the next one.': 'İlk derleme: değişim bir sonrakinden sonra görünür.',
  'No change: the same bytes as the build before.': 'Değişiklik yok: önceki derlemeyle aynı baytlar.',
  'no change': 'değişiklik yok',
  'Not committed': 'Commit edilmemiş',
  'Nothing: the working tree is as committed.': 'Hiçbir şey: çalışma ağacı commit edildiği gibi.',
  'Commits': "Commit'ler",
  'No commits touch the firmware yet.': "Henüz firmware'e dokunan commit yok.",
  'The project is not a git repository.': 'Proje bir git deposu değil.',
  'Reading git…': 'Git okunuyor…',
  'Binary or too large to show.': 'İkili ya da gösterilemeyecek kadar büyük.',
  'No file of the firmware changed here.': "Burada firmware'in hiçbir dosyası değişmedi.",
  'modified': 'değişti',
  'untracked': 'izlenmiyor',
  'added': 'eklendi',
  'deleted': 'silindi',
  'renamed': 'yeniden adlandırıldı',
  'Start': 'Başlat',
  'Stop': 'Durdur',
  'Reset': 'Sıfırla',
  'Press': 'Bas',
  'Push': 'Bas',
  'Turn left': 'Sola çevir',
  'Turn right': 'Sağa çevir',
  'Fit': 'Sığdır',
  'Top': 'Üst',
  'Front': 'Ön',
  'clear': 'temizle',
  'running': 'çalışıyor',
  'building': 'derleniyor',
  'stopped': 'durdu',
  'not running': 'çalışmıyor',
  "can't light": 'yanamaz',
  'parts not simulated': 'parça simüle edilmiyor',
  'click a button on the board to press it': 'basmak için karttaki bir düğmeye tıklayın',
  'type a command, Enter sends': 'bir komut yazın, Enter gönderir',
  'reading the board…': 'kart okunuyor…',
  'no part on this board has a model': 'bu karttaki hiçbir parçanın modeli yok',
  'This board has no 3D model yet. Lay it out in the PCB room (the placed board is exported as board.glb) and it shows here; the parts still run in the list.': 'Bu kartın henüz 3D modeli yok. PCB odasında yerleştirin (yerleşen kart board.glb olarak dışa aktarılır), burada görünür; parçalar listede yine çalışır.',
  'Release': 'Paketle', 'Download': 'İndir', 'What this note changed': 'Bu not neyi değiştirdi',
  'Before and after': 'Önce ve sonra', 'Side by side': 'Yan yana', 'Inline': 'Satır içi', 'Slider': 'Kaydırıcı',
  'What changed': 'Ne değişti', 'Changed': 'Değişenler', 'Explorer': 'Gezgin', 'Save': 'Kaydet',
  'Load theirs (drop my edits)': 'Onlarınkini yükle (benimkiler gitsin)', 'Save mine over it': 'Benimkini üstüne kaydet',
  // the MCU panel (Embedded Programming)
  'Chip': 'Çip', 'Core': 'Çekirdek', 'core': 'çekirdek', 'cores': 'çekirdek', 'Clock': 'Saat', 'max': 'en çok',
  'Flash': 'Flash', 'Supply': 'Besleme', 'Memory': 'Bellek', 'used': 'kullanılan', 'free': 'boş',
  'Build once to see memory.': 'Belleği görmek için bir kez derleyin.', 'Largest': 'En büyükler',
  'a library': 'bir kütüphane', 'Time budget': 'Zaman bütçesi', 'cycles per ms': 'çevrim / ms',
  'per core': 'çekirdek başına', 'In 1 µs:': '1 µs içinde:', 'cycles': 'çevrim', 'FreeRTOS tick': 'FreeRTOS tik',
  'Tick': 'Tik', 'cycles per tick': 'çevrim / tik', 'Build once to see the clock.': 'Saati görmek için bir kez derleyin.',
  'Peripherals': 'Çevre birimleri', 'have': 'var', 'pin': 'pin', 'pins': 'pin', 'linked': 'bağlı',
  'nothing links or wires it': 'ne kodda ne kartta kullanılıyor', 'Pins': 'Pinler', 'pad': 'ayak',
  'on the net': 'aynı nette', 'Not linked to a board: the pins of the chip and their signals.':
    'Bir karta bağlı değil: çipin pinleri ve sinyalleri.',
  'Link the app to a board to see what each pin drives.': 'Her pinin neyi sürdüğünü görmek için uygulamayı bir karta bağlayın.',
  'Seen in simulation': 'Simülasyonda görülen', 'transfers': 'aktarım', 'out': 'çıkış', 'in': 'giriş',
  'changes': 'değişim', 'Nothing yet.': 'Henüz bir şey yok.', 'Not known yet': 'Henüz bilinmeyen',
  'Sources': 'Kaynaklar', 'hover a figure': 'bir değerin üstüne gelin', 'reading the chip…': 'çip okunuyor…',
};

export function t(text: string): string {
  return LANG() === 'tr' ? TR[text] ?? text : text;
}

/** `{{ 'Keep' | t }}` - impure, so a change of language shows at once. */
@Pipe({ name: 't', pure: false })
export class T implements PipeTransform {
  transform(text: string | null | undefined): string { return t(text ?? ''); }
}
