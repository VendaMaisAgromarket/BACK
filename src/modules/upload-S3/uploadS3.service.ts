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

  public async delete(key: string): Promise<{ deleted: boolean }> {
    if (!key) throw new Error("Chave do arquivo é obrigatória");

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