export interface ProductReview {
  productId: string;
  rating: number;
}

export function publishProductReview(review: ProductReview): string {
  return `${review.productId}:${review.rating}`;
}
