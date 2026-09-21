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
  model: string | null;
  status: RevisionStatus;
  queued_at: string | null;
  image_bytes: number;
}

/** draft = LLM gormez, queued = uygulama sirasina alindi (LLM bunlari okur). */
export type RevisionStatus = 'draft' | 'queued' | 'applied' | 'rejected';

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

  /** Isaretli goruntu veritabaninda; karttan dogrudan bu adresle gosteriliyor. */
  imageUrl(id: string): string { return `/api/revisions/${id}/image`; }

  create(body: {
    comment: string; image_png: string;
    camera: CameraState | null; part: string | null; model: string | null;
  }): Observable<Revision> {
    return this.http.post<Revision>('/api/revisions', body);
  }

  remove(id: string): Observable<unknown> {
    return this.http.delete(`/api/revisions/${id}`);
  }

  setStatus(id: string, status: RevisionStatus): Observable<unknown> {
    return this.http.patch(`/api/revisions/${id}?status=${status}`, {});
  }
}

// ---------------- model katalogu ----------------
export interface ModelEntry {
  id: string; name: string; title: string;
  ready: boolean; stale: boolean; data: boolean; data_bytes: number;
  updated_at: string; sha256: string;
}
export interface FolderNode {
  name: string; path: string;
  folders: FolderNode[]; models: ModelEntry[];
}

// ---------------- model surum gecmisi ----------------
export interface ModelVersion {
  _id: string; created_at: string; note: string;
  short: string; sha256: string;
  model_count: number; chars: number;
  models?: { id: string; title: string; short: string; chars: number }[];
}

@Injectable({ providedIn: 'root' })
export class Catalog {
  private http = inject(HttpClient);

  tree(): Observable<FolderNode> { return this.http.get<FolderNode>('/api/catalog'); }

  newFolder(name: string, parent = ''): Observable<{ path: string }> {
    return this.http.post<{ path: string }>(
      `/api/catalog/folders?name=${encodeURIComponent(name)}&parent=${encodeURIComponent(parent)}`, {});
  }

  build(id: string): Observable<{ model: string; artifacts: Record<string, number> }> {
    return this.http.post<{ model: string; artifacts: Record<string, number> }>(
      `/api/models/${id}/build`, {});
  }

  createModel(id: string, source: string): Observable<unknown> {
    return this.http.put(`/api/models/${id}`, { source });
  }

  viewerUrl(id: string): string { return `/api/models/${id}/viewer.json`; }

  versions(): Observable<ModelVersion[]> {
    return this.http.get<ModelVersion[]>('/api/versions');
  }

  snapshot(note: string): Observable<ModelVersion> {
    return this.http.post<ModelVersion>(`/api/versions?note=${encodeURIComponent(note)}`, {});
  }

  restore(id: string): Observable<unknown> {
    return this.http.post(`/api/versions/${id}/restore`, {});
  }
}

// ---------------- durum ----------------
export interface Stats {
  db?: string; collections?: number; objects?: number;
  data_bytes?: number; used_bytes: number; index_bytes?: number;
  quota_bytes: number | null; percent?: number | null;
  revisions: Record<string, number>; versions: number; models?: number;
}
export interface SystemInfo {
  host: string; os: string;
  cpu: { name: string; cores: number; threads: number; load: number; freq_mhz: number | null };
  ram: { used_bytes: number; total_bytes: number; percent: number };
  gpu: { name: string; util: number; mem_used_mb: number;
         mem_total_mb: number; temp_c: number } | null;
}

@Injectable({ providedIn: 'root' })
export class Health {
  private http = inject(HttpClient);
  stats(): Observable<Stats> { return this.http.get<Stats>('/api/stats'); }
  system(): Observable<SystemInfo> { return this.http.get<SystemInfo>('/api/system'); }
}
