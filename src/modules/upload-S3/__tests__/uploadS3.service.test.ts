import { s3Client } from '../../../config/aws.config';
import { isProtectedKey, UploadS3Error, UploadS3Service } from '../uploadS3.service';

describe('UploadS3Service — exclusão de arquivos protegidos', () => {
  let service: UploadS3Service;
  let send: jest.SpyInstance;

  beforeEach(() => {
    service = new UploadS3Service({} as never);
    send = jest.spyOn(s3Client, 'send').mockResolvedValue({} as never);
  });

  afterEach(() => send.mockRestore());

  it.each([
    'certifications/farm/c1/doc.pdf',
    '/certifications/farm/c1/doc.pdf',
    '  certifications/x',
    'fotos/../certifications/farm/c1/doc.pdf',
    './certifications/farm/c1/doc.pdf',
  ])('delete() recusa com 403 e não chama o S3 (%s)', async (key) => {
    const err = await service.delete(key).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadS3Error);
    expect((err as UploadS3Error).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('delete() apaga arquivos comuns (imagens de produto, foto de perfil)', async () => {
    await expect(service.delete('abc-123-foto.png')).resolves.toEqual({ deleted: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('delete() sem chave é 400', async () => {
    const err = await service.delete('').catch((e: unknown) => e);
    expect((err as UploadS3Error).status).toBe(400);
  });

  it('deleteModuleOwnedUpload() apaga chave protegida (rollback do módulo dono)', async () => {
    await expect(service.deleteModuleOwnedUpload('certifications/farm/c1/doc.pdf')).resolves.toEqual({ deleted: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('não confunde nomes que só contêm a palavra', () => {
    expect(isProtectedKey('uuid-certifications-scan.pdf')).toBe(false);
    expect(isProtectedKey('produtos/certifications/x.png')).toBe(false);
    expect(isProtectedKey('a..b/foto.png')).toBe(false);
  });
});
