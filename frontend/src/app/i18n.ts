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
  'Tools': 'Araçlar', 'Analytics': 'Analitik',
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
  'Release': 'Paketle', 'Download': 'İndir', 'What this note changed': 'Bu not neyi değiştirdi',
  'Before and after': 'Önce ve sonra', 'Side by side': 'Yan yana', 'Inline': 'Satır içi', 'Slider': 'Kaydırıcı',
  'What changed': 'Ne değişti', 'Changed': 'Değişenler', 'Explorer': 'Gezgin', 'Save': 'Kaydet',
  'Load theirs (drop my edits)': 'Onlarınkini yükle (benimkiler gitsin)', 'Save mine over it': 'Benimkini üstüne kaydet',
};

export function t(text: string): string {
  return LANG() === 'tr' ? TR[text] ?? text : text;
}

/** `{{ 'Keep' | t }}` - impure, so a change of language shows at once. */
@Pipe({ name: 't', pure: false })
export class T implements PipeTransform {
  transform(text: string | null | undefined): string { return t(text ?? ''); }
}
