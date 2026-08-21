import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import express from "express";
import { AppModule } from "./app.module.js";
import { AppConfig, contentSecurityPolicyDirectives } from "./core/config.js";
import { GlobalExceptionFilter } from "./core/http.js";

const app = await NestFactory.create(AppModule, { bodyParser: false });
const config = app.get(AppConfig);
config.validate();
app.getHttpAdapter().getInstance().set("trust proxy", config.trustProxy);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));
app.use(cookieParser());
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: contentSecurityPolicyDirectives(),
    },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(
  "/api/v1/auth/login",
  rateLimit({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
);
app.useGlobalFilters(app.get(GlobalExceptionFilter));
app.enableShutdownHooks();
await app.listen(config.port, config.host);
console.log(`MailPilot API listening on ${config.host}:${config.port}`);
