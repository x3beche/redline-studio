import { Component } from '@angular/core';
import { T } from './i18n';
import { FILE_THUMBS, setFileThumbs } from './files-thumbs-pref';

/** Settings > Appearance > Files: whether the Files tab shows small
 *  pictures of its files (files-thumbs-pref.ts, rooms/file-mini.ts). */
@Component({
  selector: 'app-files-thumbs-setting',
  imports: [T],
  styleUrls: ['./settings.css'],
  template: `
    <div class="st-card">
      <div class="st-card-head"><h3>{{ 'Files' | t }}</h3>
        <span class="st-sub">{{ 'Small pictures in the Files tab\\'s lists and grid: a picture, a PDF\\'s first page, an STL or STEP model. Made once on the server and kept.' | t }}</span></div>
      <div class="st-card-body">
        <div class="st-icons-row">
          <span class="st-sec-title">{{ 'Thumbnails' | t }}</span>
          <span class="st-pick" role="radiogroup" [attr.aria-label]="'Thumbnails' | t">
            <button role="radio" [attr.aria-checked]="on()" [class.on]="on()" (click)="pick(true)">{{ 'On' | t }}</button>
            <button role="radio" [attr.aria-checked]="!on()" [class.on]="!on()" (click)="pick(false)">{{ 'Off' | t }}</button>
          </span>
          <span class="st-icons-about">@if (on()) { {{ 'default' | t }} } @else { {{ 'Only the kind\\'s icon; nothing is asked of the server.' | t }} }</span>
        </div>
      </div>
    </div>`,
})
export class FilesThumbsSetting {
  on = FILE_THUMBS;
  pick(on: boolean) { setFileThumbs(on); }
}
