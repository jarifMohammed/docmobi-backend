import swaggerUi from "swagger-ui-express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import basicAuth from "express-basic-auth";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the centralized swagger.json file
const swaggerFilePath = path.join(__dirname, "../docs/swagger.json");
const swaggerSpec = JSON.parse(fs.readFileSync(swaggerFilePath, "utf8"));

export const setupSwagger = (app) => {
  const isProduction = process.env.NODE_ENV === "production";

  // 1. Security: Only enable Swagger if explicitly allowed or in development
  // You can set ENABLE_SWAGGER=true in your .env if you need it in production
  const enableSwagger = process.env.ENABLE_SWAGGER === "true" || !isProduction;

  if (!enableSwagger) {
    console.log("🔒 Swagger documentation is disabled in this environment.");
    return;
  }

  // 2. Security: Add Basic Auth if credentials are provided in .env
  // Add SWAGGER_USER and SWAGGER_PASSWORD to your .env
  const swaggerUser = process.env.SWAGGER_USER;
  const swaggerPassword = process.env.SWAGGER_PASSWORD;

  if (swaggerUser && swaggerPassword) {
    app.use(
      "/api-docs",
      basicAuth({
        users: { [swaggerUser]: swaggerPassword },
        challenge: true,
      })
    );
    console.log("🔑 Swagger documentation is protected with Basic Auth.");
  } else if (isProduction) {
    console.warn("⚠️ WARNING: Swagger is enabled in production WITHOUT a password. Set SWAGGER_USER and SWAGGER_PASSWORD in .env!");
  }

  // Serve the documentation
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    swaggerOptions: {
      persistAuthorization: true,
    },
    customSiteTitle: "Docmobi API Docs",
  }));

  // Expose JSON spec (protected as well if auth is enabled)
  app.get("/api-docs.json", (req, res, next) => {
    if (swaggerUser && swaggerPassword) {
      // Basic auth middleware for this specific route if not already covered
      return basicAuth({
        users: { [swaggerUser]: swaggerPassword },
        challenge: true,
      })(req, res, () => {
        res.setHeader("Content-Type", "application/json");
        res.send(swaggerSpec);
      });
    }
    res.setHeader("Content-Type", "application/json");
    res.send(swaggerSpec);
  });

  console.log("📝 Global Swagger documentation initialized at /api-docs");
};
