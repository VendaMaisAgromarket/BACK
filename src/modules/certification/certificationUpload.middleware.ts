import { RequestHandler } from "express";
import multer from "multer";
import { CertificationError } from "./certification.errors";
import { MAX_FILES_PER_UPLOAD } from "./certification.shared";

const ALLOWED_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
export const MAX_FILE_SIZE_MB = 10;

const multerDocuments = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: MAX_FILES_PER_UPLOAD },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new CertificationError(400, "Formato não permitido: envie PDF, JPG, PNG ou WEBP."));
  },
}).array("documents", MAX_FILES_PER_UPLOAD);

/**
 * Upload dos documentos de certificação (campo `documents`, PDF/imagem). Erros do multer (arquivo
 * grande demais, arquivos demais, campo errado) viram 400 em vez de 500.
 */
export const uploadCertificationDocumentsMiddleware: RequestHandler = (req, res, next) =>
  multerDocuments(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError) {
      // LIMIT_UNEXPECTED_FILE também é o que o multer devolve quando passa do limite no campo certo.
      const unexpectedField = err.code === "LIMIT_UNEXPECTED_FILE" && err.field && err.field !== "documents";
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? `Cada arquivo pode ter no máximo ${MAX_FILE_SIZE_MB} MB.`
          : unexpectedField
            ? `Campo de arquivo "${err.field}" não reconhecido: envie os arquivos no campo "documents".`
            : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
              ? `Envie no máximo ${MAX_FILES_PER_UPLOAD} arquivos por vez.`
              : "Falha no envio dos arquivos.";
      return next(new CertificationError(400, message));
    }
    next(err);
  });
