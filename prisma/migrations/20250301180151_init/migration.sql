-- CreateEnum
CREATE TYPE "TicketProvider" AS ENUM ('TICKETTAILOR', 'TICKETMASTER');

-- CreateTable
CREATE TABLE "IgniteEvent" (
    "id" TEXT NOT NULL,
    "ticketProvider" "TicketProvider" NOT NULL DEFAULT 'TICKETTAILOR',
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IgniteEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IgniteTicketSales" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ticketProvider" "TicketProvider" NOT NULL DEFAULT 'TICKETTAILOR',
    "timestamp" TIMESTAMP(3) NOT NULL,
    "daysToEvent" INTEGER NOT NULL,
    "daysSinceOnsale" INTEGER NOT NULL,
    "ticketCount" INTEGER NOT NULL,

    CONSTRAINT "IgniteTicketSales_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "IgniteTicketSales" ADD CONSTRAINT "IgniteTicketSales_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "IgniteEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
