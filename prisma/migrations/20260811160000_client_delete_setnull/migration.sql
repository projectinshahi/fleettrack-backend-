-- Client deletion must preserve vehicles (return them to unassigned inventory) instead of
-- cascade-deleting them and their location history. Swap the Vehicle.clientId foreign key
-- from ON DELETE CASCADE to ON DELETE SET NULL. Non-destructive: only the referential
-- action changes; existing clientId values are preserved.
ALTER TABLE "Vehicle" DROP CONSTRAINT "Vehicle_clientId_fkey";

ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
