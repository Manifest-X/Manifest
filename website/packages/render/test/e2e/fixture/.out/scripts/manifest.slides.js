/* Manifest Slides */

function initializeCarouselPlugin() {

    Alpine.directive('carousel', (el, { value, modifiers, expression }, { evaluate, effect }) => {
        const state = {
            carousel: {
                autoplay: modifiers.includes('autoplay'),
                interval: 3000,
                loop: modifiers.includes('loop'),
                arrows: modifiers.includes('arrows'),
                dots: modifiers.includes('dots'),
                thumbnails: modifiers.includes('thumbnails'),
                enableDrag: !modifiers.includes('no-drag')
            },
            currentSlide: 0,
            dragging: false,
            startX: 0,

            // Get total slides by counting actual DOM elements
            get totalSlides() {
                const track = el.querySelector('.carousel-slides');
                if (!track) return 0;
                return Array.from(track.children).filter(child =>
                    child.tagName !== 'TEMPLATE'
                ).length;
            },

            // Navigation methods
            next() {
                const total = this.totalSlides;
                if (this.currentSlide >= total - 1) {
                    if (this.carousel.loop) {
                        this.currentSlide = 0;
                    }
                } else {
                    this.currentSlide++;
                }
            },

            prev() {
                const total = this.totalSlides;
                if (this.currentSlide <= 0) {
                    if (this.carousel.loop) {
                        this.currentSlide = total - 1;
                    }
                } else {
                    this.currentSlide--;
                }
            },

            goToSlide(index) {
                const total = this.totalSlides;
                if (index >= 0 && index < total) {
                    this.currentSlide = index;
                }
            },

            // Drag handlers
            startDrag(e) {
                if (!this.carousel.enableDrag) return;
                this.dragging = true;
                this.startX = e.type === 'mousedown' ? e.pageX : e.touches[0].pageX;
            },

            drag(e) {
                if (!this.dragging) return;
                e.preventDefault();
                const currentX = e.type === 'mousemove' ? e.pageX : e.touches[0].pageX;
                const diff = currentX - this.startX;

                if (Math.abs(diff) > 50) {
                    if (diff > 0) {
                        this.prev();
                    } else {
                        this.next();
                    }
                    this.dragging = false;
                }
            },

            endDrag() {
                this.dragging = false;
            },

            // Add this method to generate dots array
            get dots() {
                return Array.from({ length: this.totalSlides }, (_, i) => ({
                    index: i,
                    active: i === this.currentSlide
                }));
            }
        };

        Alpine.bind(el, {
            'x-data'() {
                return state;
            },

            'x-init'() {
                setTimeout(() => {
                    const track = el.querySelector('.carousel-slides');
                    if (!track) {
                        console.warn('[Manifest] Carousel track element not found. Expected element with class "carousel-slides"');
                        return;
                    }

                    // Setup autoplay if enabled
                    if (this.carousel.autoplay) {
                        let interval;

                        const startAutoplay = () => {
                            interval = setInterval(() => this.next(), this.carousel.interval);
                        };

                        const stopAutoplay = () => {
                            clearInterval(interval);
                        };

                        // Start autoplay
                        startAutoplay();

                        // Pause on hover if autoplay is enabled
                        el.addEventListener('mouseenter', stopAutoplay);
                        el.addEventListener('mouseleave', startAutoplay);

                        // Clean up on element removal
                        el._x_cleanups = el._x_cleanups || [];
                        el._x_cleanups.push(() => {
                            stopAutoplay();
                            el.removeEventListener('mouseenter', stopAutoplay);
                            el.removeEventListener('mouseleave', startAutoplay);
                        });
                    }
                }, 0);
            }
        });
    });
}

// Track initialization to prevent duplicates
let slidesPluginInitialized = false;

function ensureSlidesPluginInitialized() {
    if (slidesPluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') return;

    slidesPluginInitialized = true;
    initializeCarouselPlugin();
}

// Expose on window for loader to call if needed
window.ensureSlidesPluginInitialized = ensureSlidesPluginInitialized;

// Handle both DOMContentLoaded and alpine:init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureSlidesPluginInitialized);
}

document.addEventListener('alpine:init', ensureSlidesPluginInitialized);

// If Alpine is already initialized when this script loads, initialize immediately
if (window.Alpine && typeof window.Alpine.directive === 'function') {
    setTimeout(ensureSlidesPluginInitialized, 0);
} else if (document.readyState === 'complete') {
    const checkAlpine = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.directive === 'function') {
            clearInterval(checkAlpine);
            ensureSlidesPluginInitialized();
        }
    }, 10);
    setTimeout(() => clearInterval(checkAlpine), 5000);
} 