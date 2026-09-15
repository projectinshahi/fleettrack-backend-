-- POD-04.1/04.2: delivery geolocation captured on proof-of-delivery confirmation.
-- Additive, nullable → existing ProofOfDelivery rows remain valid (GPS is optional).
ALTER TABLE "ProofOfDelivery" ADD COLUMN "deliveredLat" DOUBLE PRECISION,
ADD COLUMN "deliveredLng" DOUBLE PRECISION,
ADD COLUMN "deliveredLocationAccuracy" DOUBLE PRECISION;
