# Precision safety Phase B

- API request coordinates retain JavaScript double precision.
- Five-decimal coordinate rounding is limited to R2/in-flight cache keys.
- Karney inverse calculations return a defined coincident-point sentinel when distance is below 1e-6 m.
- Exact-antipodal regression coverage was added; bearing is treated as non-unique.
- Bilinear terrain interpolation remains unchanged pending a separate constrained bicubic/Hermite implementation and validation.
