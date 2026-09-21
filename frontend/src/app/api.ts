import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface Revision {
  id: string;
  created_at: string;
  comment: string;
  image_path: string;
  camera: CameraState | null;
  part: string | null;
  status: 'open' | 'applied' | 'rejected';
}

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
}

/** Backend ile tek temas noktasi. Atlas baglantisi burada DEGIL, FastAPI'de. */
@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  list(): Observable<Revision[]> {
    return this.http.get<Revision[]>('/api/revisions');
  }

  create(body: {
    comment: string; image_png: string;
    camera: CameraState | null; part: string | null;
  }): Observable<Revision> {
    return this.http.post<Revision>('/api/revisions', body);
  }

  setStatus(id: string, status: Revision['status']): Observable<unknown> {
    return this.http.patch(`/api/revisions/${id}?status=${status}`, {});
  }
}
