-- CreateTable
CREATE TABLE `User` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(254) COLLATE utf8mb4_bin NOT NULL,
    `salt` CHAR(32) NOT NULL,
    `passwordHash` CHAR(128) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Session` (
    `id` CHAR(64) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `Session_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Workspace` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NULL,
    `guestHash` CHAR(64) NULL,

    INDEX `Workspace_userId_idx`(`userId`),
    INDEX `Workspace_guestHash_idx`(`guestHash`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Subject` (
    `id` CHAR(36) NOT NULL,
    `workspaceId` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,

    INDEX `Subject_workspaceId_idx`(`workspaceId`),
    UNIQUE INDEX `Subject_id_workspaceId_key`(`id`, `workspaceId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Analysis` (
    `id` CHAR(36) NOT NULL,
    `workspaceId` CHAR(36) NOT NULL,
    `subjectId` CHAR(36) NULL,
    `filename` TEXT NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `original` LONGBLOB NULL,
    `payload` JSON NOT NULL,

    INDEX `Analysis_workspaceId_idx`(`workspaceId`),
    INDEX `Analysis_subjectId_idx`(`subjectId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StoreRevision` (
    `id` INTEGER NOT NULL,
    `version` INTEGER NOT NULL,

    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Workspace` ADD CONSTRAINT `Workspace_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Subject` ADD CONSTRAINT `Subject_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Analysis` ADD CONSTRAINT `Analysis_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Analysis` ADD CONSTRAINT `Analysis_subjectId_workspaceId_fkey` FOREIGN KEY (`subjectId`, `workspaceId`) REFERENCES `Subject`(`id`, `workspaceId`) ON DELETE RESTRICT ON UPDATE CASCADE;

