/**
 * Talkomatic About Page JavaScript
 * ============================
 * Handles FAQ accordion functionality
 * Last updated: 2025
 */

document.addEventListener('DOMContentLoaded', function() {
  const faqItems = document.querySelectorAll('.faq-item');
  
  faqItems.forEach(item => {
      const question = item.querySelector('.faq-question');
      
      question.addEventListener('click', () => {
          const isActive = item.classList.contains('active');
          
          faqItems.forEach(faq => {
              faq.classList.remove('active');
          });
          
          if (!isActive) {
              item.classList.add('active');
          }
      });
  });
  
  if (faqItems.length > 0) {
      faqItems[0].classList.add('active');
  }
  
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', function(e) {
          e.preventDefault();
          
          const targetId = this.getAttribute('href');
          const targetElement = document.querySelector(targetId);
          
          if (targetElement) {
              window.scrollTo({
                  top: targetElement.offsetTop - 20,
                  behavior: 'smooth'
              });
          }
      });
  });
});