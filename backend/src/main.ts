import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  // Browser Origin headers have no trailing slash; normalize dashboard URL values.
  const frontendOrigin = new URL(process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173').origin;
  app.enableCors({ origin: frontendOrigin });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  await app.listen(port);
}

bootstrap().catch(error => { console.error(error); process.exitCode = 1; });
