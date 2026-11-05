import { PrismaClient } from "@prisma/client";
import { NotificationService } from "../notification/notification.service";
const prisma = new PrismaClient();
const notifications = new NotificationService(prisma);

/** Campos editáveis do endereço (fora `default`, que tem notificação própria). */
const ADDRESS_FIELDS = [
  "addressee",
  "phone_number_addressee",
  "alias",
  "street",
  "number",
  "complement",
  "referencePoint",
  "cep",
  "uf",
  "city",
] as const;

/** Vazio ("") e null contam como iguais — o formulário reenvia campos opcionais em branco. */
function sameValue(a: unknown, b: unknown): boolean {
  const normalize = (value: unknown) => (value === null || value === undefined ? "" : String(value));
  return normalize(a) === normalize(b);
}

/** Normaliza valores vindos do payload (boolean, ou string "true"/"false") para um boolean real. */
function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return !!value;
}

export class AddressService {

  async addAddress(userId: string, data: any) {
    const userExists = await prisma.user.findUnique({ where: { id: userId } });
    if (!userExists) throw new Error("Usuário não encontrado.");

    const addressCount = await prisma.address.count({ where: { userId } });
    const isDefault = addressCount === 0 ? true : toBoolean(data.default);

    if (isDefault) {
      await prisma.address.updateMany({ where: { userId }, data: { default: false } });
    }

    const address = await prisma.address.create({
      data: {
        userId,
        addressee: data.addressee,
        phone_number_addressee: data.phone_number_addressee,
        alias: data.alias,
        street: data.street,
        number: data.number,
        complement: data.complement,
        referencePoint: data.referencePoint,
        cep: data.cep,
        uf: data.uf,
        city: data.city,
        default: isDefault,
      },
    });
    await notifications.notifyAddressChanged(userId, "created", address);
    return address;
  }

  async findById(addressId: string) {
    return prisma.address.findUnique({ where: { id: addressId } });
  }

  async updateAddress(addressId: string, data: any) {
    const existing = await prisma.address.findUnique({ where: { id: addressId } });
    if (!existing) throw new Error("Endereço não encontrado.");

    const isDefault = data.default !== undefined ? toBoolean(data.default) : undefined;

    if (isDefault) {
      await prisma.address.updateMany({
        where: { userId: existing.userId },
        data: { default: false },
      });
    }

    const updateData = {
      ...(data.addressee !== undefined && { addressee: data.addressee }),
      ...(data.phone_number_addressee !== undefined && { phone_number_addressee: data.phone_number_addressee }),
      ...(data.alias !== undefined && { alias: data.alias }),
      ...(data.street !== undefined && { street: data.street }),
      ...(data.number !== undefined && { number: data.number }),
      ...(data.complement !== undefined && { complement: data.complement }),
      ...(data.referencePoint !== undefined && { referencePoint: data.referencePoint }),
      ...(data.cep !== undefined && { cep: data.cep }),
      ...(data.uf !== undefined && { uf: data.uf }),
      ...(data.city !== undefined && { city: data.city }),
      ...(isDefault !== undefined && { default: isDefault }),
    };

    const address = await prisma.address.update({ where: { id: addressId }, data: updateData });

    // O formulário reenvia o endereço inteiro: só notifica o que de fato mudou de valor.
    const fieldsChanged = ADDRESS_FIELDS.some((field) => data[field] !== undefined && !sameValue(data[field], existing[field]));
    if (fieldsChanged) {
      await notifications.notifyAddressChanged(existing.userId, "updated", address);
    } else if (isDefault && !existing.default) {
      await notifications.notifyAddressChanged(existing.userId, "default", address);
    }
    return address;
  }

  async deleteAddress(addressId: string) {
    const address = await prisma.address.findUnique({ where: { id: addressId } });
    if (!address) throw new Error("Endereço não encontrado.");
    if (address.default) {
      throw new Error("Não é possível deletar o endereço padrão. Por favor, defina outro endereço como padrão antes de excluir.");
    }
    const deleted = await prisma.address.delete({ where: { id: addressId } });
    await notifications.notifyAddressChanged(address.userId, "deleted", address);
    return deleted;
  }

  async listUserAddresses(userId: string) {
    return prisma.address.findMany({ where: { userId }, orderBy: { id: "asc" } });
  }

  async getDefaultAddress(userId: string) {
    return prisma.address.findFirst({ where: { userId, default: true } });
  }

  async setDefaultAddress(userId: string, addressId: string) {
    const address = await prisma.address.findUnique({ where: { id: addressId } });
    if (!address || address.userId !== userId) {
      throw new Error("Endereço não encontrado para este usuário.");
    }
    await prisma.address.updateMany({ where: { userId }, data: { default: false } });
    const updated = await prisma.address.update({ where: { id: addressId }, data: { default: true } });
    if (!address.default) await notifications.notifyAddressChanged(userId, "default", updated);
    return updated;
  }
}
