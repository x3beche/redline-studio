import { ApplicationConfig, ErrorHandler, provideBrowserGlobalErrorListeners,
         provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { authInterceptor } from './auth';
import { ReportingErrorHandler } from './error-report';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideHttpClient(withInterceptors([authInterceptor])),
    { provide: ErrorHandler, useClass: ReportingErrorHandler },
  ],
};
