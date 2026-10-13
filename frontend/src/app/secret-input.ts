import { Directive, ElementRef, OnInit, inject } from '@angular/core';

/** An API key, a token or a service's password typed into a settings page -
 *  never the person's own sign-in password, which the browser would fill
 *  in by itself when it sees a password field next to their address.
 *  Put on an <input type="password">: it asks for a new value (so a saved
 *  password is not offered), tells password managers to stay out, and is
 *  read-only until it is focused, which is what keeps Chrome from filling
 *  it as the page loads.
 *
 *    <input type="password" wbSecret [value]="key()" (input)="...">  */
@Directive({ selector: 'input[wbSecret]', host: { '(focus)': 'open()' } })
export class SecretInput implements OnInit {
  private el = inject(ElementRef<HTMLInputElement>).nativeElement as HTMLInputElement;
  ngOnInit() {
    const e = this.el;
    e.autocomplete = 'new-password';
    e.setAttribute('autocomplete', 'new-password');
    e.setAttribute('data-lpignore', 'true');
    e.setAttribute('data-1p-ignore', 'true');
    e.setAttribute('data-bwignore', 'true');
    e.setAttribute('data-form-type', 'other');
    e.spellcheck = false;
    e.readOnly = true;
  }
  open() { this.el.readOnly = false; }
}
