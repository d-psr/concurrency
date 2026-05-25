-- CreateTable
CREATE TABLE `accounts_result` (
    `request_id` VARCHAR(128) NOT NULL,
    `amount` INTEGER NOT NULL,
    `before` INTEGER NOT NULL,
    `after` INTEGER NOT NULL,
    `applied` BOOLEAN NOT NULL,
    `queue_wait_ms` INTEGER NOT NULL,
    `worker_instance` VARCHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`request_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
