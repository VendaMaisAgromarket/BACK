import { PrismaClient } from "@prisma/client";
import { s3Client, AWS_BUCKET_NAME } from "../../config/aws.config";
import {
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

/** Erro de regra do upload genérico, já com o status HTTP. */
export class UploadS3Error extends Error {
  constructor(
    public readonly status: 400 | 403,
    message: string
  ) {
    super(message);
    this.name = "UploadS3Error";
  }
}

/**
 * Prefixos de arquivos gerenciados por módulos com regras próprias de autorização e ciclo de vida
 * (ex.: documentos de certificação, que são evidência da avaliação). `delete()` recusa essas chaves em
 * QUALQUER caminho (endpoint genérico, limpeza de imagens de produto/perfil…); só o módulo dono apaga,
 * e apenas para desfazer um upload que ele mesmo acabou de fazer (`deleteModuleOwnedUpload`).
 */
export const PROTECTED_KEY_PREFIXES = ["certifications/"] as const;

export function isProtectedKey(key: string): boolean {
  const normalized = key.trim().replace(/^\/+/, "");
  // Segmentos "." / ".." não existem em chaves legítimas do sistema: recusa para não depender de
  // como cada camada (SDK, proxy, S3) normaliza o caminho.
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) return true;
  return PROTECTED_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export class UploadS3Service {
  private readonly prisma: PrismaClient;
  private readonly s3Client: S3Client;
  private readonly bucketName: string;
  private readonly region: string;

  constructor(prisma?: PrismaClient, region: string = "us-east-2") {
    this.prisma = prisma || new PrismaClient();
    this.s3Client = s3Client;
    this.bucketName = AWS_BUCKET_NAME;
    this.region = region;
  }

  /** `prefix` agrupa a chave numa "pasta" do bucket (ex.: "certifications/farm/<id>"). */
  public async upload(file: Express.Multer.File, prefix?: string): Promise<{
    key: string;
    url: string;
    publicUrl: string;
  }> {
    if (!file) throw new Error("Arquivo não enviado");

    const fileName = `${randomUUID()}-${file.originalname.replace(/\s+/g, '-')}`;
    const key = prefix ? `${prefix.replace(/\/+$/, "")}/${fileName}` : fileName;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ContentDisposition: "inline",
      })
    );

    const publicUrl = this.getPublicUrl(key);
    const cdnUrl = this.getCdnUrl(key);

    return {
      key,
      url: publicUrl,
      publicUrl: publicUrl,
    };
  }

  public getPublicUrl(key: string): string {
    if (!key) throw new Error("Chave do arquivo é obrigatória");

    return `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${encodeURIComponent(key)}`;
  }

  /** URL temporária de leitura (documentos privados, ex.: certificações). Padrão: 10 minutos. */
  public async getSignedReadUrl(key: string, expiresInSeconds: number = 600): Promise<string> {
    if (!key) throw new Error("Chave do arquivo é obrigatória");

    return getSignedUrl(
      this.s3Client,
      new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
      { expiresIn: expiresInSeconds }
    );
  }

  public getCdnUrl(key: string, cloudFrontDomain?: string): string {
    if (!key) throw new Error("Chave do arquivo é obrigatória");

    if (cloudFrontDomain) {
      return `https://${cloudFrontDomain}/${encodeURIComponent(key)}`;
    }

    return this.getPublicUrl(key);
  }

  /**
   * Exclusão para todos os caminhos acionados pelo usuário (endpoint genérico, imagens de produto,
   * foto de perfil). Recusa (403) chaves de prefixos protegidos: uma URL de documento de certificação
   * salva como imagem de produto/perfil não pode servir para apagar a evidência.
   */
  public async delete(key: string): Promise<{ deleted: boolean }> {
    if (!key) throw new UploadS3Error(400, "Chave do arquivo é obrigatória");
    if (isProtectedKey(key)) {
      throw new UploadS3Error(403, "Este arquivo não pode ser removido por esta rota.");
    }
    return this.sendDelete(key);
  }

  /**
   * Exclusão irrestrita, SÓ para o módulo dono de um prefixo protegido desfazer um upload que ele
   * mesmo acabou de fazer e que não chegou a ser gravado (ex.: rollback do envio de certificação).
   * Nunca chame com uma chave vinda do cliente.
   */
  public async deleteModuleOwnedUpload(key: string): Promise<{ deleted: boolean }> {
    if (!key) throw new UploadS3Error(400, "Chave do arquivo é obrigatória");
    return this.sendDelete(key);
  }

  private async sendDelete(key: string): Promise<{ deleted: boolean }> {
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      })
    );

    return { deleted: true };
  }

  public async exists(key: string): Promise<boolean> {
    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        })
      );
      return true;
    } catch (error) {
      return false;
    }
  }
}