'use client';

import { memo, useCallback, useState } from 'react';

// ─── Display-only rating stars ────────────────────────────────────────────────

type RatingDisplayProps = {
  /** Average rating (0–5). */
  rating: number;
  /** Total number of ratings submitted. */
  count: number;
  /** Optional size variant. */
  size?: 'sm' | 'md' | 'lg';
};

/**
 * Read-only star rating display with average and count.
 * Renders filled, half, and empty star characters.
 */
export const RatingDisplay = memo(function RatingDisplay({
  rating,
  count,
  size = 'md',
}: RatingDisplayProps) {
  const fullStars = Math.floor(rating);
  const halfStar = rating - fullStars >= 0.5;
  const emptyStars = 5 - fullStars - (halfStar ? 1 : 0);

  return (
    <span
      className={`rating-display rating-display--${size}`}
      aria-label={`Rating: ${rating.toFixed(1)} out of 5, ${count} ratings`}
    >
      <span className="rating-display__stars" aria-hidden="true">
        {'★'.repeat(fullStars)}
        {halfStar ? '☆' : ''}
        {'☆'.repeat(emptyStars)}
      </span>
      <span className="rating-display__value">
        {rating > 0 ? rating.toFixed(1) : '—'}
      </span>
      <span className="rating-display__count muted-text">
        ({count})
      </span>
    </span>
  );
});

// ─── Interactive rating input ─────────────────────────────────────────────────

type RatingInputProps = {
  /** Currently selected number of stars (0 = none selected). */
  value: number;
  /** Called when the user clicks a star. */
  onChange: (stars: number) => void;
  /** Disables interaction (e.g. during submission). */
  disabled?: boolean;
};

/**
 * Interactive star rating input — user hovers and clicks to select 1–5 stars.
 * Meets ARIA requirements with radio-group semantics.
 */
export const RatingInput = memo(function RatingInput({
  value,
  onChange,
  disabled = false,
}: RatingInputProps) {
  const [hoverValue, setHoverValue] = useState(0);

  const handleMouseEnter = useCallback(
    (star: number) => {
      if (!disabled) setHoverValue(star);
    },
    [disabled],
  );

  const handleMouseLeave = useCallback(() => {
    setHoverValue(0);
  }, []);

  const handleClick = useCallback(
    (star: number) => {
      if (!disabled) onChange(star);
    },
    [disabled, onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, star: number) => {
      if (disabled) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onChange(star);
      }
    },
    [disabled, onChange],
  );

  const displayValue = hoverValue || value;

  return (
    <div
      className="rating-input"
      role="radiogroup"
      aria-label="Select a rating"
      onMouseLeave={handleMouseLeave}
    >
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= displayValue;
        const selected = star === value;
        return (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`${star} star${star !== 1 ? 's' : ''}`}
            className={`rating-input__star ${filled ? 'rating-input__star--filled' : ''}`}
            disabled={disabled}
            onMouseEnter={() => handleMouseEnter(star)}
            onClick={() => handleClick(star)}
            onKeyDown={(e) => handleKeyDown(e, star)}
            tabIndex={selected || (value === 0 && star === 1) ? 0 : -1}
          >
            {filled ? '★' : '☆'}
          </button>
        );
      })}
    </div>
  );
});
